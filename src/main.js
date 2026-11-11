import SteamUser from 'steam-user';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, openSync, readFileSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { AccountManager } from './steam/accounts.js';
import { EncryptedStore, loadApiKey } from './steam/store.js';
import { ControllerState } from './state.js';
import { PluginHub } from './hub.js';
import { BindingManager } from './bindings.js';
import { createControllerHttp } from './http.js';
import { FacepunchLogStore } from './facepunch/log.js';
import { loadClientProfile } from './facepunch/client-profile.js';
import { RuntimeJournal } from './diagnostics/runtime-log.js';
import { PublicPlayerCounts } from './public-player-counts.js';
import { PopulationDiagnostics } from './diagnostics/population.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.env.CONTROLLER_DATA_DIR || join(root, 'data'));
const host = process.env.LISTEN_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3220);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
mkdirSync(data, { recursive: true, mode: 0o700 });
const lockPath = join(data, 'service.lock');
let lock;
for (let attempt = 0; attempt < 2; attempt++) {
  try { lock = openSync(lockPath, 'wx', 0o600); break; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid data/service.lock.');
    try { process.kill(pid, 0); }
    catch (probe) { if (probe.code === 'ESRCH') { unlinkSync(lockPath); continue; } throw probe; }
    throw new Error('Another controller is using this data directory.');
  }
}
if (lock === undefined) throw new Error('Could not acquire service lock.');
writeSync(lock, String(process.pid));
process.on('exit', () => { closeSync(lock); try { unlinkSync(lockPath); } catch {} });

let proxy = process.env.STEAM_HTTP_PROXY;
if (proxy === 'direct') proxy = null;
if (proxy) {
  let url;
  try { url = new URL(proxy); } catch { throw new Error('Invalid STEAM_HTTP_PROXY configuration.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('STEAM_HTTP_PROXY must be an HTTP/HTTPS URL.');
}
const runtime = new RuntimeJournal({ directory: join(data, 'logs', 'controller') });
let logWarning = false;
const record = (event, details = {}) => {
  if (!runtime.write(event, details)) {
    if (!logWarning) console.error(runtime.error);
    logWarning = true;
  } else logWarning = false;
};
process.on('uncaughtExceptionMonitor', (error, origin) => record('process_uncaught_exception', {
  name: error?.name || 'Error', code: /^[A-Z0-9_]+$/.test(error?.code) ? error.code : null, origin,
  frames: String(error?.stack || '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 12),
}));
record('service_starting', { pid: process.pid, host, port });
const accounts = new AccountManager({
  store: new EncryptedStore(join(data, 'steam')),
  createClient: () => new SteamUser({ ...(proxy ? { httpProxy: proxy } : {}),
    autoRelogin: true, renewRefreshTokens: true, dataDirectory: null, saveAppTickets: false,
    webCompatibilityMode: true, enablePicsCache: false, changelistUpdateInterval: 0 }),
  onlinePersona: SteamUser.EPersonaState.Online, resultNames: SteamUser.EResult,
  log: details => record('steam_account_state', details),
  featureOptions: { ticketLog: record },
});
const state = ControllerState.open(join(data, 'controller'));
const hub = new PluginHub({ state, log: record });
const telemetryLogs = new FacepunchLogStore({ directory: join(data, 'logs', 'facepunch') });
const telemetryProfile = loadClientProfile(join(data, 'facepunch-client-profile.json'));
const telemetryEnabled = process.env.CONTROLLER_TELEMETRY !== 'off';
const bindings = new BindingManager({ state, accounts, hub, log: record, telemetryEnabled, telemetryOptions: { profile: telemetryProfile },
  createTelemetryLog: identity => telemetryLogs.forAccount(identity) });
const publicCounts = new PublicPlayerCounts({ log: record });
const populationJournal = new RuntimeJournal({ directory: join(data, 'logs', 'population'), maxFileBytes: 16 * 1024 * 1024 });
const diagnostics = new PopulationDiagnostics({ state, hub, bindings, publicCounts, journal: populationJournal, log: record });
const apiKey = loadApiKey(data);
let stopping = false;
const server = createControllerHttp({ state, accounts, hub, bindings, apiKey, root,
  publicCounts, diagnostics,
  allowPluginDownload: process.env.ALLOW_PLUGIN_DOWNLOAD === '1', onShutdown: shutdown });
server.on('error', error => {
  record('service_error', { code: /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'HTTP_ERROR' });
  console.error(`HTTP service error: ${error.code || 'unknown'}`); shutdown(1);
});
server.listen(port, host, () => {
  console.log(`AdminLogger controller: http://${host}:${port}`);
  console.log('管理密钥：data/api-key.txt；双击 open-dashboard.cmd 可直接打开管理页面。');
  console.log('远程插件需可访问此服务。公网使用 HTTPS/WSS 反向代理。');
  console.log(`Facepunch 每账号请求、响应日志：${telemetryLogs.directory}`);
  console.log(`后端运行、认证及公共人数日志：${runtime.path}`);
  console.log(`后台人数诊断日志：${populationJournal.path}（服务器卡片中开启）`);
  if (!telemetryEnabled) console.log('诊断模式：客户端遥测已暂停，Steam 入服认证租约保持原有流程。');
  record('service_ready', { pid: process.pid, host, port, accounts: accounts.accounts.size,
    assignments: state.data.assignments.length, telemetryEnabled });
  accounts.restore();
  diagnostics.start();
});
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  record('service_stopping', { code });
  diagnostics.close(); publicCounts.close();
  const deadline = setTimeout(() => {
    record('service_shutdown_timeout', { code });
    accounts.close(); hub.close(); process.exit(code);
  }, 28000);
  try { await bindings.close(); }
  finally {
    accounts.close(); hub.close();
    server.close(); server.closeIdleConnections();
    clearTimeout(deadline);
    record('service_stopped', { code });
    setTimeout(() => process.exit(code), 1500).unref();
  }
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
