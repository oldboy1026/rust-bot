// Small adapter for the reused upstream AccountManager. Rust networking belongs
// to AdminLogger; this service only maintains Steam and the ticket lease.
import { RustAuthCheck } from './game-auth.js';
import { AnalyticsTicket } from './webapi-ticket.js';
import { ApiError } from './errors.js';
import SteamUser from 'steam-user';
import { authResponse } from '../diagnostics/auth.js';

export class AccountFeatures {
  constructor({ account, client, current, ticketOptions = {}, ticketLog = () => {} }) {
    Object.assign(this, { account, client, current });
    this.profile = {};
    const ticketHistory = new Map();
    const log = details => {
      if (details.operation === 'issued' && Number.isInteger(details.steamTicketCrc)) {
        ticketHistory.delete(details.steamTicketCrc);
        ticketHistory.set(details.steamTicketCrc, { ticketKind: details.ticketKind, operationId: details.operationId,
          leaseId: details.leaseId, requestId: details.requestId, ticketFingerprint: details.ticketFingerprint });
        if (ticketHistory.size > 1024) ticketHistory.delete(ticketHistory.keys().next().value);
      }
      ticketLog('ticket_operation', { accountId: account.saved.id, ...details });
    };
    this.rustAuth = new RustAuthCheck({ ...ticketOptions, log, client,
      requireOnline: () => this.requireOnline(), ensureCurrent: () => this.requireOnline() });
    this.analytics = new AnalyticsTicket({ ...ticketOptions, log, client, requireOnline: () => this.requireOnline() });
    client.on('accountInfo', name => { if (current()) this.profile.nickname = name; });
    // The library notification exposes a CRC and status, not the canceling
    // caller. Retain only identifiers/status; never its GC token or raw debug.
    client.on('authTicketStatus', value => {
      if (!current() || value?.appID !== 252490) return;
      try {
        const crc = value.ticketCrc;
        const known = Number.isInteger(crc) ? ticketHistory.get(crc) : null;
        const peer = value.steamID?.getSteamID64();
        ticketLog('steam_ticket_status', { accountId: account.saved.id,
          ...(known || { ticketKind: 'unknown' }), steamTicketCrc: Number.isInteger(crc) ? crc : null,
          association: known ? 'library_crc_match' : 'unmatched',
          peerSteamId: /^\d{1,20}$/.test(peer) ? peer : null,
          state: Number.isInteger(value.state) ? value.state : null,
          responseCode: Number.isInteger(value.authSessionResponse) ? value.authSessionResponse : null,
          authResponse: authResponse(SteamUser.EAuthSessionResponse?.[value.authSessionResponse]),
        });
      } catch { /* Observing a notification must not affect the connection. */ }
    });
  }
  requireOnline() {
    if (!this.current() || this.account.state !== 'online') throw new ApiError(409, '请先登录 Steam 并等待账号在线。');
  }
  snapshot() { return { profile: { ...this.profile }, idle: { enabled: false, appIds: [], status: 'stopped' } }; }
  onLoggedOn() {}
  disconnect() { this.analytics.disconnect(); this.rustAuth.disconnect(); }
}
