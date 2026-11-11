import SteamUser from 'steam-user';
import { ApiError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { ticketFingerprint } from '../diagnostics/auth.js';

const APP_ID = 252490;
const COOLDOWN_MS = 60000;
const RESULT_NAMES = new Set([
  'Fail', 'NoConnection', 'InvalidParam', 'AccessDenied', 'Timeout', 'Busy',
  'NotLoggedOn', 'ServiceUnavailable', 'AccountNotFound', 'LimitExceeded',
  'DuplicateRequest', 'InvalidState', 'ConnectFailed', 'RateLimitExceeded',
  'Expired', 'Cancelled', 'LoggedInElsewhere',
]);

class CheckError extends ApiError {}

function operationError(error, stage) {
  if (error instanceof CheckError) return error;
  const name = SteamUser.EResult[error?.eresult];
  const reason = RESULT_NAMES.has(name) ? `（${name}）` : '';
  return new CheckError(502, `${stage}失败${reason}；未完成 Rust 玩家连接验证。`);
}

// This object never persists or exposes ticket material. A request owns the
// client's Rust tickets until its underlying work and cancellation finish.
export class RustAuthCheck {
  #busy = false;
  #generation = 0;
  #lastEncryptedAttempt = null;
  #leaseController = null;
  #invalidated = new Map();

  constructor({ client, requireOnline, ensureCurrent, parseTicket = SteamUser.parseAppTicket, now = Date.now, deadlineMs = 70000, log = () => {} }) {
    Object.assign(this, { client, requireOnline, ensureCurrent, parseTicket, now, deadlineMs, log });
    client.on('authTicketStatus', status => {
      if (status?.appID !== APP_ID || !Number.isInteger(status.ticketCrc)
        || !Number.isInteger(status.authSessionResponse)) return;
      if (status.authSessionResponse === 0) this.#invalidated.delete(status.ticketCrc);
      else {
        this.#invalidated.set(status.ticketCrc, this.now());
        if (this.#invalidated.size > 256) this.#invalidated.delete(this.#invalidated.keys().next().value);
      }
    });
  }
  audit(operation, context, extra = {}) {
    try { this.log({ ticketKind: 'game', operation, ...context, ...extra }); } catch {}
  }
  captureCrc(context) {
    try {
      const tickets = this.#ownTickets();
      if (tickets.length === 1 && Number.isInteger(tickets[0].ticketCrc)) context.steamTicketCrc = tickets[0].ticketCrc;
    } catch { /* Optional library diagnostic identifier. */ }
  }

  disconnect() {
    this.#generation++;
    this.#leaseController?.abort();
  }

  activeSessionStatus() {
    try {
      this.requireOnline();
      this.ensureCurrent();
      const tickets = this.#ownTickets();
      return { available: true, active: tickets.length > 0,
        serverValidationObserved: tickets.some(ticket => ticket.validated === true) };
    } catch {
      return { available: false, active: false, serverValidationObserved: false };
    }
  }

  // Internal consumers receive the ticket only for the lifetime of callback.
  // Callback results are deliberately discarded to keep this from becoming a
  // ticket-export API. Consumers may separately retain public worker metadata.
  async withSessionTicket(callback, context = {}) {
    this.requireOnline();
    if (typeof callback !== 'function') throw new CheckError(400, 'Rust 会话操作需要内部回调。');
    if (this.#busy) throw new CheckError(409, 'Rust 票据检查或清理仍在进行，请等待完成。');
    if (this.#ownTickets().length) throw new CheckError(409, '本连接已有 Rust 会话票据，请结束原会话后再检查。');
    this.#busy = true;
    const generation = this.#generation;
    const controller = new AbortController();
    this.#leaseController = controller;
    try {
      await this.#useSessionTicket(generation, controller, callback, context);
    } finally {
      controller.abort();
      if (this.#leaseController === controller) this.#leaseController = null;
      this.#busy = false;
    }
  }

  async check() {
    this.requireOnline();
    if (this.#busy) throw new CheckError(409, 'Rust 票据检查或清理仍在进行，请等待完成。');
    if (this.#lastEncryptedAttempt !== null && this.now() - this.#lastEncryptedAttempt < COOLDOWN_MS) {
      throw new CheckError(429, '加密票据申请间隔至少为 60 秒，请稍后重试。');
    }
    if (this.#ownTickets().length) throw new CheckError(409, '本连接已有 Rust 会话票据，请结束原会话后再检查。');

    this.#busy = true;
    const generation = this.#generation;
    const run = this.#run(generation).finally(() => { this.#busy = false; });
    // A deadline releases only the HTTP caller. The exclusive claim survives
    // until late results have been canceled and their buffers have been wiped.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CheckError(504, 'Rust 票据检查超时；底层请求及清理仍在进行，完成前请勿重试。')), this.deadlineMs);
      run.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }

  #ownTickets() {
    try {
      const ownId = this.client.steamID.getSteamID64();
      return this.client.getActiveAuthSessionTickets().filter(ticket => ticket.appID === APP_ID && ticket.steamID.getSteamID64() === ownId);
    } catch {
      throw new CheckError(502, '无法确认本连接的 Rust 会话票据状态。');
    }
  }

  #assertCurrent(generation) {
    try {
      this.ensureCurrent();
      this.requireOnline();
      if (generation !== this.#generation) throw new Error();
    } catch {
      throw new CheckError(409, '账号连接已更改，本次票据检查已停止并进入清理。');
    }
  }

  #verify(buffer, buffers, session) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new CheckError(502, 'Steam 未返回预期的 Rust 票据。');
    buffers.add(buffer);
    const parsed = this.parseTicket(buffer);
    if (parsed) {
      for (const part of [parsed.authTicket, parsed.signature]) if (Buffer.isBuffer(part)) buffers.add(part);
    }
    if (!parsed || parsed.appID !== APP_ID || parsed.steamID?.getSteamID64() !== this.client.steamID?.getSteamID64()
      || parsed.hasValidSignature !== true || parsed.isValid !== true || parsed.isExpired !== false
      || (session && !Buffer.isBuffer(parsed.authTicket))) {
      throw new CheckError(502, 'Rust 票据的签名、有效期或归属核验未通过。');
    }
    return { status: 'verified', byteLength: buffer.length, appId: APP_ID, signatureValid: true };
  }

  async #cancel(sessionIssued, context) {
    this.audit('cancel_requested', context, { scope: 'app_all_owned_tickets' });
    try {
      const result = await this.#cancelImpl(sessionIssued, context);
      this.audit('cancel_returned', context, { ...result,
        confirmationScope: result.status === 'already_invalidated' ? 'steam_status_and_local_absence' : 'library_result_and_local_list' });
      return result;
    } catch (error) {
      this.audit('cancel_failed', context);
      throw error;
    }
  }
  async #cancelImpl(sessionIssued, context) {
    const count = this.#ownTickets().length;
    if (count === 0) {
      // A matched Steam notification can remove the active entry before the
      // lease unwinds. Cleanup is then complete without another cancel call.
      const invalidatedAt = this.#invalidated.get(context?.steamTicketCrc);
      if (sessionIssued && invalidatedAt !== undefined && invalidatedAt >= context.issuedAtMs) {
        return { status: 'already_invalidated', canceledTicketCount: 0, cancelApiCalled: false };
      }
      if (sessionIssued) throw new CheckError(502, 'Rust 会话票据已不在本连接中，无法确认本次取消。');
      return { status: 'not_needed', canceledTicketCount: 0, cancelApiCalled: false };
    }
    // v5.3.0 compares Long objects by identity for the optional token filter.
    // Exclusivity was checked before issuance, so cancel this app as a whole.
    this.audit('cancel_api_call', context, { appId: APP_ID, scope: 'app_all_owned_tickets' });
    const result = await this.client.cancelAuthSessionTickets(APP_ID);
    if (result?.canceledTicketCount !== count || this.#ownTickets().length !== 0) {
      throw new CheckError(502, 'Rust 会话票据取消未确认；请结束该账号连接后重试。');
    }
    return { status: 'confirmed', canceledTicketCount: count, cancelApiCalled: true };
  }

  async #useSessionTicket(generation, controller, callback, context) {
    context.operationId = randomUUID();
    const buffers = new Set();
    let createAttempted = false;
    let sessionIssued = false;
    let failure;
    try {
      this.#assertCurrent(generation);
      createAttempted = true;
      this.audit('issue_requested', context);
      const session = await this.client.createAuthSessionTicket(APP_ID);
      if (Buffer.isBuffer(session?.sessionTicket)) buffers.add(session.sessionTicket);
      sessionIssued = true;
      this.#assertCurrent(generation);
      this.#verify(session?.sessionTicket, buffers, true);
      context.ticketFingerprint = ticketFingerprint(session.sessionTicket);
      context.issuedAtMs = this.now();
      this.captureCrc(context);
      this.audit('issued', context);
      await callback({ sessionTicket: session.sessionTicket, steamId: this.client.steamID.getSteamID64(), signal: controller.signal });
      this.#assertCurrent(generation);
    } catch (error) {
      this.audit('operation_failed', context);
      failure = operationError(error, 'Rust 会话操作');
    } finally {
      controller.abort();
      try {
        if (createAttempted) await this.#cancel(sessionIssued, context);
      } catch (error) {
        failure = operationError(error, 'Rust 会话票据清理');
      } finally {
        for (const buffer of buffers) buffer.fill(0);
      }
    }
    if (failure) throw failure;
  }

  async #run(generation) {
    const context = { operationId: randomUUID(), reason: 'diagnostic_ticket_check' };
    const buffers = new Set();
    let stage = 'Rust 所有权票据申请';
    let createAttempted = false;
    let sessionIssued = false;
    let result;
    let failure;
    try {
      this.#assertCurrent(generation);
      const ownership = await this.client.getAppOwnershipTicket(APP_ID);
      if (Buffer.isBuffer(ownership?.appOwnershipTicket)) buffers.add(ownership.appOwnershipTicket);
      this.#assertCurrent(generation);
      const ownershipCheck = this.#verify(ownership?.appOwnershipTicket, buffers, false);

      stage = 'Rust 会话票据申请';
      createAttempted = true;
      this.audit('issue_requested', context);
      const session = await this.client.createAuthSessionTicket(APP_ID);
      if (Buffer.isBuffer(session?.sessionTicket)) buffers.add(session.sessionTicket);
      sessionIssued = true;
      this.#assertCurrent(generation);
      const sessionCheck = this.#verify(session?.sessionTicket, buffers, true);
      context.ticketFingerprint = ticketFingerprint(session.sessionTicket);
      context.issuedAtMs = this.now();
      this.captureCrc(context);
      this.audit('issued', context);

      stage = 'Rust 加密票据申请';
      this.#lastEncryptedAttempt = this.now();
      const encrypted = await this.client.createEncryptedAppTicket(APP_ID, Buffer.alloc(0));
      if (Buffer.isBuffer(encrypted?.encryptedAppTicket)) buffers.add(encrypted.encryptedAppTicket);
      this.#assertCurrent(generation);
      if (!Buffer.isBuffer(encrypted?.encryptedAppTicket) || encrypted.encryptedAppTicket.length === 0) {
        throw new CheckError(502, 'Steam 未返回预期的 Rust 加密票据。');
      }
      result = {
        appId: APP_ID, status: 'issued_and_canceled', ownership: ownershipCheck,
        authSession: { ...sessionCheck, status: 'issued_and_canceled' },
        encryptedApp: { status: 'issued', byteLength: encrypted.encryptedAppTicket.length },
        serverValidated: false, eacVerified: false, playerConnected: false,
      };
    } catch (error) {
      failure = operationError(error, stage);
    } finally {
      try {
        if (createAttempted) {
          const cleanup = await this.#cancel(sessionIssued, context);
          if (result) result.cleanup = cleanup;
        }
      } catch (error) {
        failure = operationError(error, 'Rust 会话票据清理');
      } finally {
        for (const buffer of buffers) buffer.fill(0);
      }
    }
    if (failure) throw failure;
    return result;
  }
}
