import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ApiError, equalSecret, publicOrigin, requireText, safeError } from './util.js';
import { PublicPlayerCounts, resolveGameEndpoint, gameSettings } from './public-player-counts.js';

async function readJson(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, '请求需使用 application/json。');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw new ApiError(413, '请求过大。');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new ApiError(400, 'JSON 格式不正确。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, '请求体必须是 JSON 对象。');
  return value;
}

export function createControllerHttp({ state, accounts, hub, bindings, apiKey, root, allowPluginDownload = false, onShutdown,
  publicCounts = new PublicPlayerCounts(), diagnostics }) {
  const plugin = readFileSync(join(root, 'plugin', 'AdminLogger.cs'));
  const pluginHash = createHash('sha256').update(plugin).digest('hex');
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', readFileSync(join(root, 'public', 'index.html'))]],
    ['/app.js', ['text/javascript; charset=utf-8', readFileSync(join(root, 'public', 'app.js'))]],
    ['/style.css', ['text/css; charset=utf-8', readFileSync(join(root, 'public', 'style.css'))]],
  ]);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    const json = (status, payload) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(request.url, 'http://controller.local');
      const path = url.pathname;
      if (request.method === 'GET' && path === '/health') { json(200, { ok: true, service: 'adminlogger-controller' }); return; }
      if (request.method === 'GET' && assets.has(path)) {
        const [type, content] = assets.get(path);
        response.writeHead(200, { 'Content-Type': type }); response.end(content); return;
      }
      if (request.method === 'GET' && ['/api/plugin/hash', '/api/plugin/download'].includes(path)) {
        if (!hub.authorize(request.headers.authorization)) throw new ApiError(401, '插件认证失败。');
        if (url.searchParams.get('name') !== 'AdminLogger.cs') throw new ApiError(404, '找不到插件文件。');
        if (path.endsWith('/hash')) { json(200, { hash: pluginHash }); return; }
        if (!allowPluginDownload) throw new ApiError(403, '源码下载未启用，请使用项目 plugin 目录中的文件安装。');
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="AdminLogger.cs"' });
        response.end(plugin); return;
      }
      if (!path.startsWith('/api/')) throw new ApiError(404, '接口不存在。');
      const token = String(request.headers.authorization || '');
      if (!equalSecret(token, `Bearer ${apiKey}`)) throw new ApiError(401, '管理密钥不正确，请重新解锁。');
      if (request.headers.origin) {
        let origin;
        try { origin = new URL(request.headers.origin); } catch { throw new ApiError(403, '请求来源不正确。'); }
        if (origin.host !== request.headers.host) throw new ApiError(403, '拒绝跨站请求。');
      }
      if (request.method === 'GET' && path === '/api/state') {
        json(200, { accounts: accounts.list(),
          servers: state.data.servers.map(({ pairKey: _key, ...item }) => {
            const view = hub.view(item.id);
            return { ...item, ...view, population: bindings.population(item.id, view), diagnostics: diagnostics?.view(item.id) || null };
          }),
          assignments: bindings.list(), events: state.events.slice(-60).reverse() }); return;
      }
      if (request.method === 'GET' && path === '/api/public-player-counts') {
        const targets = state.data.servers.map(item => {
          const view = hub.view(item.id);
          return { id: item.id, endpoint: resolveGameEndpoint(item, view), population: bindings.population(item.id, view) };
        });
        json(200, await publicCounts.query(targets)); return;
      }
      const pair = path.match(/^\/api\/servers\/([\w-]+)\/pair$/);
      if (request.method === 'GET' && pair) { json(200, state.pair(pair[1])); return; }
      const input = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ? await readJson(request) : {};
      if (request.method === 'POST' && path === '/api/accounts') {
        const id = input.id || requireText(input.accountName, '账号名', 64).toLowerCase();
        json(202, accounts.login(id, { accountName: input.accountName, password: input.password })); return;
      }
      if (request.method === 'POST' && path === '/api/accounts/import') {
        if (typeof input.text !== 'string') throw new ApiError(400, '请填写账号列表。');
        const lines = input.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (!lines.length || lines.length > 100) throw new ApiError(400, '每批请输入 1–100 行。');
        const results = [];
        for (let i = 0; i < lines.length; i++) {
          const colon = lines[i].indexOf(':');
          if (colon < 1) { results.push({ line: i + 1, ok: false, error: '需要 账号:密码 格式。' }); continue; }
          const name = lines[i].slice(0, colon), password = lines[i].slice(colon + 1);
          try { accounts.login(name.toLowerCase(), { accountName: name, password }); results.push({ line: i + 1, ok: true }); }
          catch { results.push({ line: i + 1, ok: false, error: '账号格式不正确、已存在连接或导入失败。' }); }
          lines[i] = '';
        }
        input.text = '';
        json(202, { results }); return;
      }
      const logout = id => accounts.logout(id, () => bindings.stopAccount(id));
      if (request.method === 'POST' && path === '/api/accounts/batch-logout') {
        if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 1000
          || input.ids.some(id => typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id))) {
          throw new ApiError(400, '请选择 1–1000 个有效账号。');
        }
        const results = await Promise.all([...new Set(input.ids)].map(async id => {
          try { await logout(id); return { id, ok: true }; }
          catch (error) { return { id, ok: false, error: safeError(error) }; }
        }));
        json(200, { results }); return;
      }
      const account = path.match(/^\/api\/accounts\/([\w-]+)(?:\/(login|guard|logout))?$/);
      if (account) {
        const [, id, action] = account;
        if (request.method === 'POST' && action === 'login') { json(202, accounts.login(id)); return; }
        if (request.method === 'POST' && action === 'guard') { json(202, accounts.submitGuard(id, input.code)); return; }
        if (request.method === 'POST' && action === 'logout') { json(200, await logout(id)); return; }
        if (request.method === 'DELETE' && !action) { await logout(id); accounts.remove(id); json(200, { ok: true }); return; }
      }
      if (request.method === 'POST' && path === '/api/servers') { const item = state.createServer(input); json(201, { id: item.id }); return; }
      const serverRoute = path.match(/^\/api\/servers\/([\w-]+)(?:\/(sync|ping|stop|assignments|diagnostics))?$/);
      if (serverRoute) {
        const [, id, action] = serverRoute;
        const item = state.server(id);
        if (request.method === 'POST' && action === 'stop') {
          const result = await bindings.stopServer(id);
          json(result.pending ? 202 : 200, result); return;
        }
        if (request.method === 'POST' && action === 'diagnostics') {
          if (!diagnostics) throw new ApiError(503, '人数诊断未初始化。');
          json(200, diagnostics.setEnabled(id, input.enabled)); return;
        }
        if (request.method === 'PATCH' && !action) {
          const name = input.name === undefined ? item.name : requireText(input.name, '服务器名称', 80);
          const publicUrl = input.publicUrl === undefined ? item.publicUrl : publicOrigin(input.publicUrl);
          const target = gameSettings(input, item);
          Object.assign(item, { name, publicUrl, ...target }); state.save(); json(200, { ok: true }); return;
        }
        if (request.method === 'POST' && action === 'sync') { await bindings.sync(id); json(200, { ok: true }); return; }
        if (request.method === 'POST' && action === 'ping') { await hub.command(id, 'ping'); json(200, { ok: true }); return; }
        if (request.method === 'DELETE' && action === 'assignments') {
          const result = await bindings.removeServerAssignments(id);
          json(result.pending ? 202 : 200, result); return;
        }
        if (request.method === 'DELETE' && !action) {
          if (state.data.assignments.some(entry => entry.serverId === id)) throw new ApiError(409, '请先移除该服务器的所有分配记录。');
          diagnostics?.stopCapture(id, 'server_removed');
          hub.connections.get(id)?.socket.terminate();
          state.data.servers = state.data.servers.filter(entry => entry.id !== id); state.save(); json(200, { ok: true }); return;
        }
      }
      if (request.method === 'POST' && path === '/api/assignments') { json(201, bindings.create(input)); return; }
      const assignment = path.match(/^\/api\/assignments\/([\w-]+)(?:\/(start|stop))?$/);
      if (assignment) {
        const [, id, action] = assignment;
        if (request.method === 'POST' && action === 'start') { bindings.start(id); json(202, { ok: true }); return; }
        if (request.method === 'POST' && action === 'stop') { await bindings.stop(id); json(200, { ok: true }); return; }
        if (request.method === 'DELETE' && !action) {
          const result = await bindings.remove(id);
          json(result.pending ? 202 : 200, { ok: true, ...result }); return;
        }
      }
      if (request.method === 'POST' && path === '/api/shutdown' && onShutdown) {
        json(202, { ok: true }); setImmediate(onShutdown); return;
      }
      throw new ApiError(404, '接口不存在。');
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(error instanceof ApiError ? error.status : 500, { error: safeError(error) });
      else response.destroy();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('upgrade', (request, socket, head) => hub.upgrade(request, socket, head));
  return server;
}
