import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ApiError, equalSecret, deferred } from './util.js';
import { publicIPv4 } from './public-player-counts.js';
import { authResponse as normalizeAuthResponse, authDiagnostic } from './diagnostics/auth.js';

const COMMANDS = new Set(['ping', 'reconcile', 'register_bot', 'unregister_bot', 'refresh_ticket']);
const EVENTS = new Set(['plugin_init', 'bot_registered', 'bot_unregistered', 'bot_killed', 'bot_respawned',
  'bot_respawn_failed', 'steam_auth_ok', 'steam_auth_lost', 'auth_diagnostic', 'env_tick', 'fp_server_event']);
const HELLO_FIELDS = ['server_steam_id', 'protocol', 'protocol_string', 'hostname', 'max_players', 'map',
  'world_size', 'world_seed', 'server_ip', 'game_port', 'query_port', 'rcon_port', 'env_time', 'env_daylength',
  'map_filename', 'world_ts', 'map_url', 'world_metadata_status', 'plugin_version'];

function serverInfo(payload) {
  const info = {};
  for (const key of HELLO_FIELDS) {
    const value = payload?.[key];
    if (typeof value === 'string') info[key] = value.slice(0, key === 'map_filename' ? 512 : key === 'map_url' ? 2048 : 300);
    else if (typeof value === 'number' && Number.isFinite(value)) info[key] = value;
  }
  if (!info.map_url && typeof payload?.level_url === 'string') info.map_url = payload.level_url.slice(0, 2048);
  if (Array.isArray(payload?.required_props) && payload.required_props.length <= 4096
    && payload.required_props.every(prop => typeof prop === 'string' && prop.length <= 1024)
    && Buffer.byteLength(JSON.stringify(payload.required_props)) <= 64 * 1024) {
    info.required_props = structuredClone(payload.required_props);
  }
  return info;
}

export class PluginHub extends EventEmitter {
  constructor({ state, commandTimeout = 12000, heartbeatMs = 15000, log = () => {} }) {
    super();
    Object.assign(this, { state, commandTimeout, log });
    this.connections = new Map();
    this.pending = new Map();
    this.serverViews = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
    this.wss.on('connection', (socket, request, serverId) => this.accept(socket, serverId, request));
    this.heartbeat = setInterval(() => this.sweep(), heartbeatMs);
    this.heartbeat.unref();
  }
  authorize(value) {
    const token = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
    return this.state.data.servers.find(server => equalSecret(token, server.pairKey));
  }
  upgrade(request, socket, head) {
    // HTTP releases its socket error handler on upgrade. Protect the raw socket
    // before authorization too: a peer can reset while we send the 401 response.
    socket.on('error', error => {
      this.record('plugin_transport_error', { code: /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'SOCKET_ERROR' });
      socket.destroy();
    });
    const server = this.authorize(request.headers.authorization);
    if (request.url !== '/ws' || !server || request.headers.origin) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(request, socket, head, ws => this.wss.emit('connection', ws, request, server.id));
  }
  accept(socket, serverId, request) {
    this.connections.get(serverId)?.socket.terminate();
    this.rejectPending(serverId);
    const connection = { socket, ready: false, lastSeen: Date.now(), openedAt: Date.now() };
    this.connections.set(serverId, connection);
    this.record('plugin_connected', { serverId });
    const previous = this.serverViews.get(serverId) || {};
    this.serverViews.set(serverId, { ...previous, connected: false, bots: [], lastReconciledAt: null,
      remoteIp: publicIPv4(request?.socket?.remoteAddress), lastConnectedAt: new Date().toISOString() });
    socket.on('error', () => {});
    socket.on('pong', () => { connection.lastSeen = Date.now(); });
    socket.on('message', (bytes, binary) => {
      if (this.connections.get(serverId) !== connection) return;
      if (binary) { socket.close(1003); return; }
      try {
        const msg = JSON.parse(bytes.toString('utf8'));
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error();
        connection.lastSeen = Date.now();
        this.inbound(serverId, connection, msg);
      } catch { socket.close(1007, 'Invalid message'); }
    });
    socket.on('close', () => {
      if (this.connections.get(serverId) !== connection) return;
      this.connections.delete(serverId);
      this.serverViews.set(serverId, { ...this.serverViews.get(serverId), connected: false, disconnectedAt: Date.now() });
      this.rejectPending(serverId);
      this.record('plugin_disconnected', { serverId });
      this.emit('offline', serverId);
    });
  }
  record(event, details) { try { this.log(event, details); } catch {} }
  updateInfo(serverId, payload, source) {
    const info = serverInfo(payload);
    const previous = this.serverViews.get(serverId) || {};
    const metadata = value => Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'env_time' && key !== 'env_daylength'));
    const changed = JSON.stringify(metadata(previous.info || {})) !== JSON.stringify(metadata(info));
    this.serverViews.set(serverId, { ...previous, info });
    if (changed) this.record('server_metadata_updated', { serverId, source,
      mapFilename: info.map_filename || null, worldTimestamp: info.world_ts ?? null,
      mapUrlPresent: Boolean(info.map_url), requiredPropsAvailable: Array.isArray(info.required_props),
      requiredPropsCount: info.required_props?.length ?? null, status: info.world_metadata_status || 'legacy_plugin' });
    return info;
  }
  send(socket, value) {
    if (socket.readyState !== WebSocket.OPEN) throw new ApiError(503, '插件连接已断开，执行结果可能尚未确认。');
    socket.send(JSON.stringify(value), error => { if (error) socket.terminate(); });
  }
  inbound(serverId, connection, msg) {
    const socket = connection.socket;
    if (msg.type === 'hello') {
      this.updateInfo(serverId, msg.payload, 'hello');
      connection.ready = true;
      this.serverViews.set(serverId, { ...this.serverViews.get(serverId), connected: true });
      this.send(socket, { type: 'hello_ack', ts: Math.floor(Date.now() / 1000) });
      this.emit('ready', serverId);
      return;
    }
    if (!connection.ready) { socket.close(1008, 'hello required'); return; }
    if (msg.type === 'hb') return;
    if (msg.type === 'resp') {
      const request = this.pending.get(msg.replyTo);
      if (!request || request.serverId !== serverId || request.connection !== connection) return;
      clearTimeout(request.timer);
      this.pending.delete(msg.replyTo);
      const payload = msg.payload;
      if (!payload || payload.ok !== true) {
        this.record('plugin_command_failed', { serverId, command: request.name, code: 'PLUGIN_REJECTED' });
        // Do not expose arbitrary remote errors: plugin debug/error text can
        // contain input. The command name is our own allowlisted value.
        request.reject(new ApiError(502, `插件拒绝执行 ${request.name}，请检查服务器日志。`));
      } else request.resolve(payload);
      return;
    }
    if (msg.type !== 'event' || !Number.isSafeInteger(msg.id) || msg.id <= 0) return;
    const payload = msg.payload;
    const event = payload?.event;
    if (!EVENTS.has(event) || typeof payload.steam_id !== 'string' || !/^\d{1,20}$/.test(payload.steam_id)) return;
    // IDs can restart after the original plugin is reloaded with an empty
    // outbox. Include the payload digest so a new event is not dropped as old.
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const key = `${serverId}:${msg.id}:${digest}`;
    if (!this.state.data.eventKeys.includes(key)) {
      this.state.data.eventKeys.push(key);
      if (this.state.data.eventKeys.length > 2048) this.state.data.eventKeys.shift();
      this.state.save();
      // Raw detail (including real-player event copies) is not retained or
      // printed. Consumers receive only metadata required for managed leases.
      this.state.record({ serverId, steamId: payload.steam_id, event });
      const authResponse = event === 'steam_auth_lost' ? normalizeAuthResponse(payload.detail) : null;
      const diagnostic = event === 'auth_diagnostic' ? authDiagnostic(payload.detail) : null;
      if (diagnostic) this.record('plugin_auth_diagnostic', { serverId, steamId: payload.steam_id, ...diagnostic });
      if (event !== 'env_tick' && event !== 'fp_server_event') this.record('plugin_event', {
        serverId, steamId: payload.steam_id, name: event, sourceTimestamp: Number(payload.timestamp) || 0, authResponse });
      this.emit('plugin-event', serverId, { event, steamId: payload.steam_id,
        timestamp: Number(payload.timestamp) || 0, authResponse });
    }
    this.send(socket, { type: 'ack', ackId: msg.id, ts: Math.floor(Date.now() / 1000) });
  }
  connected(id) { return this.connections.get(id)?.ready === true; }
  view(id) { return this.serverViews.get(id) || { connected: false, info: {}, bots: [] }; }
  async command(serverId, name, payload = {}) {
    if (!COMMANDS.has(name)) throw new ApiError(400, '不支持的插件命令。');
    const connection = this.connections.get(serverId);
    if (!connection?.ready) throw new ApiError(503, '服务器插件尚未连接。');
    const id = this.state.nextCommandId();
    const wait = deferred();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.record('plugin_command_failed', { serverId, command: name, code: 'COMMAND_TIMEOUT' });
      wait.reject(new ApiError(504, '插件响应超时，执行结果未知；将先核对状态再处理。'));
    }, this.commandTimeout);
    this.pending.set(id, { ...wait, timer, serverId, connection, name });
    try {
      if (name !== 'reconcile' && name !== 'ping') this.record('plugin_command_started', { serverId, command: name, steamId: payload.steam_id || null });
      this.send(connection.socket, { id, type: 'cmd', name, payload, ts: Math.floor(Date.now() / 1000) });
    }
    catch (error) { clearTimeout(timer); this.pending.delete(id); wait.reject(error); }
    return wait.promise;
  }
  rejectPending(serverId) {
    for (const [id, request] of this.pending) {
      if (request.serverId !== serverId) continue;
      clearTimeout(request.timer);
      this.pending.delete(id);
      request.reject(new ApiError(503, '插件连接中断，执行结果尚未确认。'));
    }
  }
  async reconcile(id) {
    const connection = this.connections.get(id);
    const result = await this.command(id, 'reconcile');
    if (this.connections.get(id) !== connection) throw new ApiError(503, '插件已重新连接，请重新核对状态。');
    if (!Array.isArray(result.bots) || result.bots.length > 20000) throw new ApiError(502, '插件返回的机器人名单格式错误。');
    const bots = result.bots.filter(bot => typeof bot.steam_id === 'string' && /^\d{1,20}$/.test(bot.steam_id))
      .map(bot => ({ steamId: bot.steam_id, name: String(bot.name || '').slice(0, 128),
        alive: bot.alive === true, health: Number(bot.health) || 0, reportedSteamSession: bot.has_steam_session === true,
        ...(typeof bot.steam_auth_confirmed === 'boolean' ? { reportedSteamAuthConfirmed: bot.steam_auth_confirmed } : {}) }));
    if (result.server_info && typeof result.server_info === 'object' && !Array.isArray(result.server_info)) {
      this.updateInfo(id, result.server_info, 'reconcile');
    }
    this.serverViews.set(id, { ...this.view(id), bots, lastReconciledAt: new Date().toISOString() });
    return bots;
  }
  sweep() {
    for (const { socket, lastSeen, ready, openedAt } of this.connections.values()) {
      if (Date.now() - lastSeen > 65000 || (!ready && Date.now() - openedAt > 15000)) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }
  close() {
    clearInterval(this.heartbeat);
    for (const [id, connection] of this.connections) { this.rejectPending(id); connection.socket.terminate(); }
    this.connections.clear();
    this.wss.close();
  }
}
