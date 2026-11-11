// Headless local UI/production-startup smoke test. Uses synthetic plugin data;
// never logs in to Steam, loads old accounts or sends a real auth ticket.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = process.env.BROWSER_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!browserPath) throw new Error('Set BROWSER_PATH to a local Chrome/Edge executable for this optional smoke test.');
const temporary = mkdtempSync(join(tmpdir(), 'adminlogger-browser-'));
const data = join(temporary, 'data'), profile = join(temporary, 'browser');
const portReservation = createServer(); portReservation.listen(0, '127.0.0.1'); await once(portReservation, 'listening');
const port = portReservation.address().port; await new Promise(resolve => portReservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let browser, service, page, plugin, managementKey;
async function wait(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await delay(100);
  }
  throw new Error('Local UI smoke test timed out.');
}
class DevTools {
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map(); this.errors = [];
    socket.on('message', bytes => {
      const message = JSON.parse(bytes);
      if (message.method === 'Runtime.exceptionThrown') this.errors.push('Browser runtime exception');
      const wait = this.pending.get(message.id);
      if (!wait) return;
      this.pending.delete(message.id);
      clearTimeout(wait.timer);
      if (message.error) wait.reject(new Error('DevTools command failed.'));
      else wait.resolve(message.result);
    });
    socket.on('error', () => {});
  }
  send(method, params = {}, timeoutMs = 10000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`DevTools ${method} timed out (command ${id}).`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('UI expression failed.');
    return result.result?.value;
  }
}
try {
  service = spawn(process.execPath, ['src/main.js'], { cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, CONTROLLER_DATA_DIR: data, LISTEN_HOST: '127.0.0.1', PORT: String(port) } });
  await wait(async () => (await fetch(`${origin}/health`)).ok);
  managementKey = readFileSync(join(data, 'api-key.txt'), 'utf8').trim();
  browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--no-proxy-server', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
  await wait(() => existsSync(join(profile, 'DevToolsActivePort')));
  const debuggingPort = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json();
  const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open'); page = new DevTools(socket);
  await page.send('Runtime.enable'); await page.send('Page.enable');
  await page.send('Page.navigate', { url: `${origin}/#key=${managementKey}` }, 30000);
  await wait(() => page.evaluate("document.getElementById('workspace')?.hidden === false"));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  assert.equal(await page.evaluate('location.hash'), '');
  await page.evaluate("document.getElementById('add-server').click()");
  await page.evaluate("document.querySelector('#dialog-content input[type=text]').value='示例 Rust 服务器'; document.querySelector('#dialog-content form').requestSubmit()");
  await wait(() => page.evaluate("document.querySelectorAll('.server-card').length===1 && !document.getElementById('dialog').open"));
  await page.evaluate("document.querySelector('.server-card button').click()");
  await wait(() => page.evaluate("document.querySelector('.command')?.value.startsWith('rne.pair ')"));
  const pair = await page.evaluate("document.querySelector('.command').value");
  await page.evaluate("document.getElementById('dialog-close').click()");
  await wait(() => page.evaluate("document.getElementById('dialog-content').childElementCount===0"));
  assert.ok(!(await page.evaluate('document.body.innerText')).includes(managementKey));
  plugin = new WebSocket(`${origin.replace('http:', 'ws:')}/ws`, { headers: { Authorization: `Bearer ${pair.split(' ')[1]}` } });
  plugin.on('error', () => {});
  plugin.on('message', bytes => {
    const msg = JSON.parse(bytes);
    if (msg.type === 'cmd') plugin.send(JSON.stringify({ type: 'resp', replyTo: msg.id,
      payload: { ok: true, ...(msg.name === 'reconcile' ? { bots: [] } : {}) } }));
  });
  await once(plugin, 'open');
  plugin.send(JSON.stringify({ type: 'hello', payload: { hostname: 'Rust · 本地协议验证', map: 'Procedural Map', protocol: 2635,
    map_filename: 'fixture.map', required_props: [], world_ts: '1793095186410',
    world_metadata_status: 'ready', plugin_version: '2.5.7' } }));
  await page.evaluate("document.getElementById('refresh').click()");
  await wait(() => page.evaluate("document.getElementById('metric-servers').textContent==='1'"));
  assert.ok(await page.evaluate("document.querySelector('.server-card .meta').innerText.includes('地图资料已自动同步')"));
  await wait(() => page.evaluate("document.querySelector('.population-grid')?.innerText.includes('最终 Steam 认证')"));
  assert.equal(await page.evaluate("[...document.querySelectorAll('.population-grid dd')].map(x=>x.textContent).join(',')"), '0,0 / 0,0 / 0');
  const stateResponse = await fetch(`${origin}/api/state`, { headers: { Authorization: `Bearer ${managementKey}` } });
  const fixtureServerId = (await stateResponse.json()).servers[0].id;
  await page.evaluate("[...document.querySelectorAll('.server-card button')].find(x=>x.textContent==='开启人数诊断').click()");
  await wait(() => page.evaluate("document.querySelector('.server-card').innerText.includes('后台采集中')"));
  await page.evaluate("[...document.querySelectorAll('.server-card button')].find(x=>x.textContent==='停止人数诊断').click()");
  await wait(() => page.evaluate("[...document.querySelectorAll('.server-card button')].some(x=>x.textContent==='开启人数诊断')"));
  // Mock only the browser's public-count response, without contacting Facepunch.
  // Backend lookup, authentication and shared upstream fetching have separate tests.
  await page.evaluate(`window.publicCountSmokeFetch=window.fetch;
    window.publicCountSmokeMode='five'; window.publicCountSmokeTimes=[];
    window.fetch=async (...args) => {
      if(args[0]!=='/api/public-player-counts') return window.publicCountSmokeFetch(...args);
      window.publicCountSmokeTimes.push(Date.now());
      const mode=window.publicCountSmokeMode;
      const item={id:${JSON.stringify(fixtureServerId)},endpoint:'1.2.3.4:28015',
        checkedAt:new Date().toISOString(),sourceUpdatedAt:new Date().toISOString(),
        status:mode==='absent'?'not_listed':mode==='error'?'error':mode==='address'?'waiting_address':'ok',
        count:mode==='five'?5:mode==='zero'?0:null,lastKnownCount:mode==='error'?0:null};
      return new Response(JSON.stringify({intervalMs:3000,servers:[item]}),{status:200,headers:{'Content-Type':'application/json'}});
    }; document.getElementById('refresh').click()`);
  await wait(() => page.evaluate("document.querySelector('.public-count strong')?.textContent==='5 人'"));
  await page.evaluate("window.publicCountSmokeMode='zero'");
  await wait(() => page.evaluate("document.querySelector('.public-count strong')?.textContent==='0 人'"));
  const pollTimes = await page.evaluate('window.publicCountSmokeTimes');
  assert.ok(pollTimes.length >= 2);
  assert.ok(pollTimes[1] - pollTimes[0] >= 2000 && pollTimes[1] - pollTimes[0] <= 5000, 'Expected automatic three-second polling');
  await page.evaluate("window.publicCountSmokeMode='error'");
  await wait(() => page.evaluate("document.querySelector('.public-count strong')?.textContent==='查询失败'"));
  assert.ok(await page.evaluate("document.querySelector('.public-count').innerText.includes('上次成功：0 人（已过期）')"));
  await page.evaluate("window.publicCountSmokeMode='absent'");
  await wait(() => page.evaluate("document.querySelector('.public-count strong')?.textContent==='未收录'"));
  await page.evaluate("window.publicCountSmokeMode='address'");
  await wait(() => page.evaluate("document.querySelector('.public-count strong')?.textContent==='待配置'"));
  await page.evaluate("[...document.querySelectorAll('.server-card button')].find(x=>x.textContent==='设置').click()");
  await page.evaluate("document.querySelector('[name=gameIp]').value='1.2.3.4'; document.querySelector('[name=gamePort]').value='28015'; window.publicCountSmokeMode='five'; document.querySelector('#dialog-content form').requestSubmit()");
  await wait(() => page.evaluate("!document.getElementById('dialog').open && document.querySelector('.public-count strong')?.textContent==='5 人'"));
  await wait(() => page.evaluate("document.getElementById('dialog-content').childElementCount===0"));
  await page.evaluate("document.getElementById('add-account').click()");
  assert.ok(await page.evaluate("document.querySelector('#dialog-content input[type=password]') !== null"));
  await page.evaluate("document.getElementById('dialog-close').click()");
  await wait(() => page.evaluate("document.getElementById('dialog-content').childElementCount===0"));
  await page.evaluate("document.getElementById('import-accounts').click()");
  assert.ok(await page.evaluate("document.querySelector('#dialog-content textarea') !== null"));
  await page.evaluate("document.getElementById('dialog-close').click()");
  // Exercise single and batch assignment forms without logging in to Steam.
  await wait(() => page.evaluate("document.getElementById('dialog-content').childElementCount===0"));
  await page.evaluate(`window.assignmentSmokeFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await window.assignmentSmokeFetch(...args);
      if (args[0] !== '/api/state') return response;
      const state = await response.json();
      state.accounts = [{id:'ui-only',accountName:'UI test',state:'offline'}];
      return new Response(JSON.stringify(state), {status:response.status,headers:response.headers});
    };
    document.getElementById('refresh').click()`);
  await wait(() => page.evaluate("document.querySelector('#account-list input[type=checkbox]') !== null"));
  await page.evaluate("document.getElementById('add-assignment').click()");
  assert.equal(await page.evaluate("document.querySelectorAll('#dialog-content input').length"), 1);
  assert.ok(!(await page.evaluate("document.getElementById('dialog-content').innerText")).includes('IP'));
  await page.evaluate("document.getElementById('dialog-close').click()");
  await wait(() => page.evaluate("document.getElementById('dialog-content').childElementCount===0"));
  await page.evaluate("document.querySelector('#account-list input[type=checkbox]').click(); document.getElementById('selected-assign').click()");
  assert.equal(await page.evaluate("document.querySelectorAll('#dialog-content input').length"), 0);
  assert.ok(!(await page.evaluate("document.getElementById('dialog-content').innerText")).includes('IP'));
  await page.evaluate(`document.getElementById('dialog-close').click();
    window.confirm=()=>true; window.bulkActions=[]; window.mockAssignment=true; window.mockEnabled=true;
    window.fetch=async (...args) => {
      const path=args[0], method=args[1]?.method;
      if (path==='/api/accounts/batch-logout' && method==='POST') {
        const ids=JSON.parse(args[1].body).ids;
        window.bulkActions.push('logout:'+ids.join(','));
        if(ids.length===2) await new Promise(resolve=>window.finishAllLogout=resolve);
        return Response.json({results:ids.map(id=>({id,ok:true}))});
      }
      if (path==='/api/servers/'+${JSON.stringify(fixtureServerId)}+'/stop' && method==='POST') {
        window.bulkActions.push('stopped');
        await new Promise(resolve=>window.finishServerStop=resolve);
        window.mockEnabled=false;
        return Response.json({stopped:1,pending:0});
      }
      if (path==='/api/servers/'+${JSON.stringify(fixtureServerId)}+'/assignments' && method==='DELETE') {
        window.bulkActions.push('deleted'); window.mockAssignment=false;
        return Response.json({deleted:1,pending:0});
      }
      const response=await window.assignmentSmokeFetch(...args);
      if(path!=='/api/state') return response;
      const state=await response.json();
      state.accounts=[{id:'ui-only',accountName:'UI test',state:'retry_wait',retryAt:new Date().toISOString()},
        {id:'ui-offline',accountName:'Offline test',state:'offline'}];
      if(window.mockAssignment) state.assignments=[{id:'fixture-assignment',accountId:'ui-only',serverId:${JSON.stringify(fixtureServerId)},enabled:window.mockEnabled,phase:window.mockEnabled?'waiting_steam':'stopped'}];
      return Response.json(state);
    };
    document.getElementById('refresh').click()`);
  await wait(() => page.evaluate("document.querySelector('#account-list').innerText.includes('等待自动重试')"));
  await page.evaluate("document.querySelector('[data-action=stop-server]').click()");
  await wait(() => page.evaluate("window.bulkActions[0]==='stopped' && document.querySelector('[data-action=stop-server]').disabled"));
  await page.evaluate("document.getElementById('refresh').click()");
  await wait(() => page.evaluate("document.querySelector('[data-action=stop-server]').textContent==='正在停止…' && document.querySelector('[data-action=stop-server]').disabled"));
  await page.evaluate("document.querySelector('[data-action=stop-server]').click(); window.finishServerStop()");
  await wait(() => page.evaluate("document.getElementById('notice').textContent.includes('已停止 1 条会话') && document.querySelector('[data-action=stop-server]').textContent==='一键停止（0）'"));
  assert.equal(await page.evaluate("window.bulkActions.filter(action=>action==='stopped').length"), 1);
  assert.ok(await page.evaluate("document.querySelector('#assignment-list').innerText.includes('已停止')"));
  await page.evaluate("document.getElementById('selected-logout').click()");
  await wait(() => page.evaluate("window.bulkActions[1]==='logout:ui-only' && document.getElementById('notice').textContent.includes('已退出 1 个账号')"));
  await page.evaluate("document.querySelector('#account-list input[type=checkbox]').click()");
  assert.equal(await page.evaluate("document.getElementById('selected-count').textContent"), '已选 0 个');
  await wait(() => page.evaluate("!document.getElementById('logout-all').disabled"));
  await page.evaluate("document.getElementById('logout-all').click()");
  await wait(() => page.evaluate("window.finishAllLogout && document.getElementById('logout-all').disabled && document.getElementById('logout-all').textContent==='正在退出…'"));
  assert.ok(await page.evaluate("document.getElementById('add-assignment').disabled && !document.querySelector('#assignment-list button') && !document.querySelector('#account-list button')"));
  await page.evaluate("window.finishAllLogout()");
  await wait(() => page.evaluate("window.bulkActions[2]==='logout:ui-only,ui-offline' && document.getElementById('notice').textContent.includes('已退出 2 个账号')"));
  await page.evaluate("[...document.querySelectorAll('.server-card button')].find(x=>x.textContent.startsWith('删除全部分配')).click()");
  await wait(() => page.evaluate("window.bulkActions[3]==='deleted' && !document.querySelector('#assignment-list button')"));
  await page.evaluate("window.fetch=window.assignmentSmokeFetch; delete window.assignmentSmokeFetch; document.getElementById('refresh').click()");
  await wait(() => page.evaluate("document.querySelector('#account-list input[type=checkbox]') === null"));
  mkdirSync(join(root, 'docs'), { recursive: true });
  const layout = await page.send('Page.getLayoutMetrics');
  const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: 1440, height: Math.min(layout.cssContentSize.height, 2500), scale: 1 } });
  writeFileSync(join(root, 'docs', 'dashboard-preview.png'), Buffer.from(shot.data, 'base64'));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(200);
  assert.ok(await page.evaluate('document.documentElement.scrollWidth <= 390'), 'Mobile layout overflow');
  assert.ok(await page.evaluate("['logout-all'].every(id=>{const box=document.getElementById(id).getBoundingClientRect();return box.left>=0&&box.right<=390&&box.height>0})"), 'Mobile bulk action is outside the viewport width');
  await page.evaluate("document.getElementById('accounts').scrollIntoView({block:'start'})");
  await delay(100);
  const mobile = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, 'docs', 'dashboard-mobile.png'), Buffer.from(mobile.data, 'base64'));
  await page.evaluate("document.getElementById('lock').click()");
  assert.equal(await page.evaluate("document.getElementById('unlock').hidden"), false);
  assert.equal(await page.evaluate("sessionStorage.getItem('adminlogger-key')"), null);
  assert.equal(page.errors.length, 0);
  console.log('Production startup, pairing, WebSocket handshake, public-count diagnostics, server stop, selected/all logout, deletion, dialogs, mobile layout and locking passed.');
  console.log('Screenshots saved in docs/. No Steam login was attempted.');
} finally {
  plugin?.terminate();
  if (page) { try { await page.send('Browser.close'); } catch {} page.socket.terminate(); }
  browser?.kill();
  if (service && managementKey) {
    try { await fetch(`${origin}/api/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${managementKey}`, 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
    await Promise.race([once(service, 'exit'), delay(5000)]);
  }
  service?.kill();
  await delay(500);
  if (!resolve(temporary).startsWith(resolve(tmpdir(), 'adminlogger-browser-'))) throw new Error('Unexpected cleanup path.');
  try { rmSync(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch {}
}
