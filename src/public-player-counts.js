import { BlockList, isIPv4 } from 'node:net';
import { ApiError } from './util.js';
import { randomUUID } from 'node:crypto';

export const FACEPUNCH_COUNTS_URL = 'https://api.facepunch.com/api/public/steamServers/playerCounts/rust';
export const PUBLIC_COUNTS_INTERVAL_MS = 3000;
const excluded = new BlockList();
for (const cidr of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3']) {
  const [ip, prefix] = cidr.split('/'); excluded.addSubnet(ip, Number(prefix), 'ipv4');
}
export function publicIPv4(value) {
  if (typeof value !== 'string') return null;
  const ip = value.trim().replace(/^::ffff:/i, '');
  return isIPv4(ip) && !excluded.check(ip, 'ipv4') ? ip : null;
}
function gamePort(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}
export function gameSettings(input, current = {}) {
  const ip = input.gameIp === undefined ? current.gameIp || '' : input.gameIp;
  const port = input.gamePort === undefined ? current.gamePort ?? null : input.gamePort;
  if (typeof ip !== 'string' || (ip.trim() && !publicIPv4(ip))) {
    throw new ApiError(400, '游戏服务器 IP 必须是公网 IPv4，留空则自动识别。');
  }
  if (port !== null && port !== '' && !gamePort(port)) {
    throw new ApiError(400, '游戏端口必须是 1–65535 的整数，留空则使用插件上报值。');
  }
  const query = input.queryPort === undefined ? current.queryPort ?? null : input.queryPort;
  if (query !== null && query !== '' && !gamePort(query)) throw new ApiError(400, 'UDP 查询端口必须是 1–65535 的整数。');
  return { gameIp: ip.trim() ? publicIPv4(ip) : '', gamePort: gamePort(port),
    ...((input.queryPort !== undefined || current.queryPort !== undefined) ? { queryPort: gamePort(query) } : {}) };
}
export function resolveQueryEndpoint(server, view = {}) {
  const host = publicIPv4(server.gameIp) || publicIPv4(view.info?.server_ip) || publicIPv4(view.remoteIp);
  const port = gamePort(server.queryPort) || gamePort(view.info?.query_port);
  return host && port ? { host, port } : null;
}
export function resolveGameEndpoint(server, view = {}) {
  const ip = publicIPv4(server.gameIp) || publicIPv4(view.info?.server_ip) || publicIPv4(view.remoteIp);
  const port = gamePort(server.gamePort) || gamePort(view.info?.game_port);
  return ip && port ? `${ip}:${port}` : null;
}

// One upstream map serves every paired server and every browser tab. Requests
// share an in-flight fetch and at most one attempt per three-second time slot.
export class PublicPlayerCounts {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, intervalMs = PUBLIC_COUNTS_INTERVAL_MS, timeoutMs = 8000,
    log = () => {} } = {}) {
    Object.assign(this, { fetchImpl, now, intervalMs, timeoutMs, log });
    this.lastLogged = new Map();
    this.lastSlot = null;
    this.inFlight = null;
    this.counts = null;
    this.checkedAt = null;
    this.updatedAt = null;
    this.sourceUpdatedAt = null;
    this.cacheAge = null;
    this.error = null;
    this.controller = new AbortController();
    this.lastRequest = null;
    this.lastSuccessfulRequest = null;
  }
  close() { this.controller.abort(); }
  async refresh() {
    if (this.inFlight) return this.inFlight;
    const slot = Math.floor(this.now() / this.intervalMs);
    if (this.lastSlot === slot) return;
    this.lastSlot = slot;
    this.inFlight = (async () => {
      const started = this.now();
      const metadata = { requestId: randomUUID(), startedAt: new Date(started).toISOString(),
        status: null, headers: {}, outcome: 'error' };
      try {
        const url = new URL(FACEPUNCH_COUNTS_URL);
        url.searchParams.set('_', String(slot));
        const response = await this.fetchImpl(url.href, {
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.timeoutMs)]), headers: { 'Cache-Control': 'no-cache' },
        });
        metadata.status = response.status;
        for (const name of ['date', 'age', 'last-modified', 'cache-control', 'etag', 'via', 'x-cache',
          'x-cache-hits', 'cf-cache-status', 'cf-ray', 'x-request-id']) {
          const value = response.headers.get(name);
          if (value !== null) metadata.headers[name] = value.slice(0, 512);
        }
        if (!response.ok) throw new Error('Upstream response failed.');
        const data = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)
          || Object.values(data).some(value => !Number.isSafeInteger(value) || value < 0)) {
          throw new Error('Invalid upstream count map.');
        }
        this.counts = data;
        this.updatedAt = new Date(this.now()).toISOString();
        const modified = Date.parse(response.headers.get('last-modified'));
        this.sourceUpdatedAt = Number.isFinite(modified) ? new Date(modified).toISOString() : null;
        const age = response.headers.get('age');
        this.cacheAge = age !== null && /^\d+$/.test(age) ? Number(age) : null;
        this.error = null;
        metadata.outcome = 'ok';
        this.lastSuccessfulRequest = metadata;
      } catch {
        this.error = 'Facepunch 查询失败，稍后自动重试。';
      } finally {
        metadata.durationMs = Math.max(0, this.now() - started);
        this.lastRequest = metadata;
        this.checkedAt = new Date(this.now()).toISOString();
      }
    })();
    try { await this.inFlight; }
    finally { this.inFlight = null; }
  }
  async query(targets) {
    if (targets.some(target => target.endpoint)) await this.refresh();
    const result = { intervalMs: this.intervalMs, servers: targets.map(({ id, endpoint }) => {
      const base = { id, endpoint, count: null, checkedAt: endpoint ? this.checkedAt : null,
        updatedAt: endpoint ? this.updatedAt : null, sourceUpdatedAt: endpoint ? this.sourceUpdatedAt : null,
        cacheAge: endpoint ? this.cacheAge : null, request: endpoint ? this.lastRequest : null,
        lastSuccessfulRequest: endpoint ? this.lastSuccessfulRequest : null };
      if (!endpoint) return { ...base, status: 'waiting_address' };
      if (this.error) return { ...base, status: 'error', error: this.error,
        lastKnownCount: this.counts && Object.hasOwn(this.counts, endpoint) ? this.counts[endpoint] : null };
      if (!this.counts || !Object.hasOwn(this.counts, endpoint)) return { ...base, status: 'not_listed' };
      return { ...base, status: 'ok', count: this.counts[endpoint] };
    }) };
    const liveIds = new Set(targets.map(item => item.id));
    for (const id of this.lastLogged.keys()) if (!liveIds.has(id)) this.lastLogged.delete(id);
    for (const [index, item] of result.servers.entries()) {
      const population = targets[index].population;
      const signature = JSON.stringify([item.endpoint, item.status, item.count, item.lastKnownCount,
        population?.enabledAssignments, population?.pluginEntities, population?.presentAssignments, population?.steamAuthenticated]);
      const previous = this.lastLogged.get(item.id);
      if (!previous || signature !== previous.signature || this.now() - previous.at >= 60000) {
        this.lastLogged.set(item.id, { signature, at: this.now() });
        try { this.log('public_player_count', { serverId: item.id, ...item, ...(population ? { population } : {}) }); } catch {}
      }
    }
    return result;
  }
}
