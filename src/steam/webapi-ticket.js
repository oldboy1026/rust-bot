import SteamUser from 'steam-user';
import { randomFillSync, randomUUID } from 'node:crypto';
import { ticketFingerprint } from '../diagnostics/auth.js';
import { createRequire } from 'node:module';
import { ApiError } from './errors.js';

const require = createRequire(import.meta.url);
const { Hashing, IPv4 } = createRequire(require.resolve('steam-user'))('@doctormckay/stdlib');
const { version } = require('steam-user/package.json');
const APP_ID = 252490;
const bridges = new WeakMap();
const fail = message => new ApiError(502, message);

// steam-user 5.3.0 has no WebAPI-ticket method. This instance-only bridge also
// receives ACKs without a JobID; it never changes SteamUser's shared prototype.
function ackBridge(client) {
  if (bridges.has(client)) return bridges.get(client);
  const base = client._handlerManager;
  if (!base?.hasHandler || !base?.emit) throw fail('当前 Steam 连接不支持专用票据确认。');
  const listeners = new Set();
  const notify = body => { for (const fn of listeners) fn(body); };
  const ack = SteamUser.EMsg.ClientAuthListAck;
  client._handlerManager = {
    hasHandler: name => name === ack || base.hasHandler(name),
    emit(instance, name, ...args) {
      if (name === ack) notify(args[0]);
      return base.emit(instance, name, ...args);
    },
    add: (...args) => base.add(...args),
  };
  const bridge = { listeners, notify };
  bridges.set(client, bridge);
  return bridge;
}

// Layout reference: SteamKit2 SteamAuthTicket.GetAuthTicketForWebApi. The
// signed ownership ticket and one-use GC token still come from this account.
export function buildWebApiTicket(client, token, ownership) {
  const auth = Buffer.alloc(4 + token.length + 4 + 24);
  auth.writeUInt32LE(token.length, 0);
  token.copy(auth, 4);
  const pos = token.length + 4;
  auth.writeUInt32LE(24, pos);
  auth.writeUInt32LE(1, pos + 4);
  auth.writeUInt32LE(5, pos + 8);
  auth.writeUInt32LE(IPv4.stringToInt(client.publicIP || '0.0.0.0') >>> 0, pos + 12);
  auth.writeUInt32LE(0, pos + 16);
  auth.writeUInt32LE((Date.now() - (client._connectTime || Date.now())) >>> 0, pos + 20);
  client._connectionCount = ((client._connectionCount || 0) + 1) >>> 0;
  auth.writeUInt32LE(client._connectionCount, pos + 24);
  const rawLength = auth.length + 4 + ownership.length;
  const ticket = Buffer.alloc(Math.max(2560, rawLength));
  auth.copy(ticket);
  ticket.writeUInt32LE(ownership.length, auth.length);
  ownership.copy(ticket, auth.length + 4);
  if (rawLength < ticket.length) randomFillSync(ticket, rawLength);
  return { auth, ticket, crc: Hashing.crc32(auth) >>> 0 };
}

export class AnalyticsTicket {
  constructor({ client, requireOnline, parseTicket = SteamUser.parseAppTicket, ackTimeoutMs = 10000, log = () => {} }) {
    Object.assign(this, { client, requireOnline, parseTicket, ackTimeoutMs, log });
    this.controller = new AbortController();
    this.busy = false;
  }
  audit(operation, context, extra = {}) {
    try { this.log({ ticketKind: 'analytics', operation, ...context, ...extra }); } catch {}
  }
  disconnect() {
    this.controller.abort();
    this.controller = new AbortController();
  }
  async sendList(entry, adding, signal, context = {}) {
    const client = this.client;
    const bridge = ackBridge(client);
    const seq = ++client._authSeqMe;
    return new Promise((resolve, reject) => {
      let timer, settled = false;
      const finish = (error, acknowledged = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        bridge.listeners.delete(onAck);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(acknowledged);
      };
      const onAbort = () => finish(signal.reason || new Error('Aborted'));
      const onAck = body => {
        client._authSeqThem = body.message_sequence;
        const present = (body.ticket_crc || []).includes(entry.ticket_crc);
        if (adding ? present : body.message_sequence === seq && !present) {
          this.audit('auth_list_ack', context, { listAction: adding ? 'add' : 'remove', sequence: seq,
            ackSequence: body.message_sequence,
            acknowledgedCrcs: (body.ticket_crc || []).filter(Number.isInteger).slice(0, 256) });
          finish(null, true);
        }
      };
      bridge.listeners.add(onAck);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(null, false), this.ackTimeoutMs);
      try {
        signal?.throwIfAborted();
        this.requireOnline();
        const tickets = [...client._activeAuthTickets];
        this.audit('auth_list_submitted', context, { listAction: adding ? 'add' : 'remove', sequence: seq,
          listedTickets: tickets.slice(0, 256).map(item => ({ appId: item.gameid, crc: item.ticket_crc })) });
        client._send(SteamUser.EMsg.ClientAuthList, {
          tokens_left: client._gcTokens.length,
          last_request_seq: seq - 1, last_request_seq_from_server: client._authSeqThem,
          tickets, app_ids: [...new Set([APP_ID, ...tickets.map(item => item.gameid)])],
          message_sequence: seq,
        }, bridge.notify);
      } catch (error) { finish(error); }
    });
  }
  async withTicket(callback, { signal, requestId } = {}) {
    this.requireOnline();
    if (this.busy) throw fail('该账号的遥测上传或票据清理仍在进行。');
    const client = this.client;
    if (version !== '5.3.0' || !Array.isArray(client._gcTokens) || !Array.isArray(client._activeAuthTickets)
      || !Number.isInteger(client._authSeqMe) || typeof client._send !== 'function') {
      throw fail('当前 Steam 库与遥测票据适配器不兼容。');
    }
    this.busy = true;
    const current = this.controller.signal;
    const combined = AbortSignal.any([current, ...(signal ? [signal] : [])]);
    let entry, built, ownership;
    const context = { operationId: randomUUID(), ...(requestId ? { requestId } : {}) };
    let reason = 'upload_finished';
    let cleanupAcknowledged = null;
    this.audit('issue_requested', context);
    try {
      combined.throwIfAborted();
      const response = await client.getAppOwnershipTicket(APP_ID);
      combined.throwIfAborted();
      this.requireOnline();
      if (!Buffer.isBuffer(response?.appOwnershipTicket)) throw fail('Steam 未返回 Rust 所有权票据。');
      ownership = Buffer.from(response.appOwnershipTicket);
      const parsed = this.parseTicket(ownership);
      if (parsed?.appID !== APP_ID || parsed.steamID?.getSteamID64() !== client.steamID.getSteamID64()
        || parsed.hasValidSignature !== true || parsed.isValid !== true || parsed.isExpired !== false) {
        throw fail('遥测票据的账号归属、签名或有效期核验失败。');
      }
      if (!client._gcTokens.length) throw fail('Steam 暂无可用的连接令牌，稍后重试遥测上传。');
      const token = client._gcTokens.shift();
      try { built = buildWebApiTicket(client, token, ownership); }
      finally { token.fill(0); }
      entry = { estate: 0, steamid: 0, gameid: APP_ID, h_steam_pipe: client._hSteamPipe,
        ticket: built.auth, ticket_crc: built.crc, server_secret: Buffer.from('str:analytics\0') };
      client._activeAuthTickets.push(entry);
      context.ticketFingerprint = ticketFingerprint(built.ticket);
      context.steamTicketCrc = built.crc;
      this.audit('issued', context);
      const steamAcknowledged = await this.sendList(entry, true, combined, context);
      this.audit('list_add_returned', context, { acknowledged: steamAcknowledged });
      combined.throwIfAborted();
      this.requireOnline();
      await callback({ ticket: built.ticket, steamId: client.steamID.getSteamID64(), steamAcknowledged });
    } catch (error) {
      reason = combined.aborted ? 'upload_aborted' : 'upload_failed';
      this.audit('operation_failed', context, { reason });
      throw error;
    } finally {
      try {
        if (entry) {
          this.audit('cleanup_requested', context, { reason, scope: 'exact_analytics_entry' });
          // Remove this exact object; never cancel the account's game ticket.
          const index = client._activeAuthTickets.indexOf(entry);
          if (index !== -1) client._activeAuthTickets.splice(index, 1);
          try {
            this.requireOnline();
            if (!current.aborted) cleanupAcknowledged = await this.sendList(entry, false, undefined, context);
          } catch { cleanupAcknowledged = false; }
          this.audit('cleanup_returned', context, { reason, acknowledged: cleanupAcknowledged,
            locallyRemoved: !client._activeAuthTickets.includes(entry) });
        }
      } finally {
        ownership?.fill(0);
        built?.auth.fill(0);
        built?.ticket.fill(0);
        entry?.server_secret.fill(0);
        this.busy = false;
      }
    }
    return { cleanupAcknowledged };
  }
}
