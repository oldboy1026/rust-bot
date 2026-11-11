import { randomUUID } from 'node:crypto';
import { randomChinaPublicIPv4 } from './network/china-ipv4.js';
import { ApiError, requireText, deferred, safeError } from './util.js';
import { FacepunchTelemetry } from './facepunch/telemetry.js';
import { resolveGameEndpoint } from './public-player-counts.js';
import { ticketFingerprint } from './diagnostics/auth.js';

export class BindingManager {
  constructor({ state, accounts, hub, intervalMs = 10000, offlineGraceMs = 120000, authTimeoutMs = 90000,
    retryMs = 3000, errorRetryMs = 30000, authLossRetryMs = 30000, telemetryEnabled = true, telemetryOptions = {}, createTelemetry = options => new FacepunchTelemetry(options),
    createTelemetryLog = () => null, log = () => {} }) {
    Object.assign(this, { state, accounts, hub, offlineGraceMs, authTimeoutMs, retryMs, errorRetryMs, authLossRetryMs });
    Object.assign(this, { telemetryEnabled, telemetryOptions, createTelemetry, createTelemetryLog, log });
    this.telemetryStatuses = new Map();
    this.telemetryClients = new Map();
    this.runs = new Map();
    this.syncing = new Map();
    this.resync = new Set();
    this.statuses = new Map();
    this.sessionEnds = new Map();
    this.retryAt = new Map();
    this.closed = false;
    hub.on('ready', id => this.schedule(id));
    hub.on('plugin-event', (id, event) => this.onEvent(id, event));
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }
  assignment(id) {
    const item = this.state.data.assignments.find(item => item.id === id);
    if (!item) throw new ApiError(404, '找不到机器人分配记录。');
    return item;
  }
  setStatus(id, phase, error = null) {
    const previous = this.statuses.get(id);
    this.statuses.set(id, { phase, error, updatedAt: new Date().toISOString() });
    if (previous?.phase !== phase || previous?.error !== error) {
      const item = this.state.data.assignments.find(item => item.id === id);
      this.record('assignment_state', { assignmentId: id, accountId: item?.accountId, serverId: item?.serverId,
        steamId: item?.steamId, previousPhase: previous?.phase || null, phase, error });
    }
  }
  record(event, details) { try { this.log(event, details); } catch {} }
  isAuthenticated(id) {
    const run = this.runs.get(id);
    return run?.authenticated === true && !run.stopping;
  }
  list() {
    return this.state.data.assignments.map(item => ({ ...item,
      ...(this.statuses.get(item.id) || { phase: item.enabled ? 'waiting' : item.needsCleanup ? 'cleanup_pending' : 'stopped' }),
      ticketActive: Boolean(this.runs.get(item.id)?.ticket),
      steamAuthenticated: this.isAuthenticated(item.id),
      steamAuthenticatedAt: this.isAuthenticated(item.id) ? this.runs.get(item.id).authenticatedAt : null,
      lastSessionEnd: this.sessionEnds.get(item.id) || null,
      authAttemptId: this.runs.get(item.id)?.attemptId || null,
      leaseId: this.runs.get(item.id)?.leaseId || null,
      retryAt: item.enabled && !this.runs.has(item.id) && this.retryAt.has(item.id) ? new Date(this.retryAt.get(item.id)).toISOString() : null,
      ticketFingerprint: this.runs.get(item.id)?.ticketFingerprint || null,
      facepunch: this.telemetryStatuses.get(item.id) || { status: this.telemetryEnabled ? 'waiting_role' : 'disabled_for_diagnostic', simulated: true } }));
  }
  population(serverId, view) {
    const assignments = this.state.data.assignments.filter(item => item.serverId === serverId && item.enabled);
    const base = { enabledAssignments: assignments.length, reconciledAt: view.lastReconciledAt ?? null };
    if (!view.connected || !base.reconciledAt) {
      return { ...base, pluginEntities: null, presentAssignments: null, steamAuthenticated: null };
    }
    const entities = new Set(view.bots.filter(bot => bot.alive).map(bot => bot.steamId));
    const present = assignments.filter(item => entities.has(item.steamId));
    return { ...base, pluginEntities: entities.size, presentAssignments: present.length,
      steamAuthenticated: present.filter(item => this.isAuthenticated(item.id)).length };
  }
  create(input) {
    if (this.closed) throw new ApiError(503, '服务正在停止。');
    const account = this.accounts.get(input.accountId);
    if (account.loggingOut) throw new ApiError(409, '该账号正在退出，暂时无法创建分配。');
    this.state.server(input.serverId);
    if (this.state.data.assignments.some(item => item.accountId === input.accountId)) {
      throw new ApiError(409, '该账号已有分配记录，请先停止并删除原记录。');
    }
    const displayName = requireText(input.displayName || account.features?.profile.nickname || account.saved.accountName, '显示名称');
    const ip = randomChinaPublicIPv4(this.state.data.assignments.map(item => item.ip));
    const item = { id: randomUUID(), accountId: input.accountId, serverId: input.serverId,
      displayName, ip, enabled: true, steamId: account.saved.steamId || null, needsCleanup: false };
    this.state.data.assignments.push(item);
    this.state.save();
    this.schedule(item.serverId);
    return item;
  }
  start(id) {
    const item = this.assignment(id);
    if (item.deletePending) throw new ApiError(409, '该分配正在删除，不能重新启动。');
    if (this.accounts.get(item.accountId).loggingOut) throw new ApiError(409, '该账号正在退出。');
    item.enabled = true;
    this.retryAt.delete(id);
    this.state.save();
    this.schedule(item.serverId);
  }
  async stop(id) {
    await this.stopMany([this.assignment(id)]);
  }
  async stopServer(serverId) {
    this.state.server(serverId);
    const items = this.state.data.assignments.filter(item => item.serverId === serverId
      && (item.enabled || item.needsCleanup || this.runs.has(item.id)));
    await this.stopMany(items, false, 'server_stopped');
    return { stopped: items.length, pending: items.filter(item => item.needsCleanup).length };
  }
  async stopMany(items, deleting = false, reason = deleting ? 'assignment_deleted' : 'assignment_stopped') {
    if (!items.length) return;
    for (const item of items) {
      item.enabled = false;
      if (deleting) item.deletePending = true;
    }
    this.state.save();
    const runs = [];
    for (const item of items) {
      const run = this.runs.get(item.id);
      if (run) {
        this.release(run, reason);
        runs.push(run.done);
      }
      this.telemetryClients.delete(item.id);
    }
    await Promise.all(runs);
    const servers = new Set();
    for (const item of items) {
      if (this.finalizeDeletion(item)) continue;
      this.setStatus(item.id, item.needsCleanup ? 'cleanup_pending' : 'stopped');
      if (item.needsCleanup && this.hub.connected(item.serverId)) servers.add(item.serverId);
    }
    await Promise.all([...servers].map(serverId => this.sync(serverId)));
  }
  async remove(id) {
    return this.removeMany([this.assignment(id)]);
  }
  async removeServerAssignments(serverId) {
    this.state.server(serverId);
    return this.removeMany(this.state.data.assignments.filter(item => item.serverId === serverId));
  }
  async removeMany(items) {
    await this.stopMany(items, true);
    const pending = items.filter(item => this.state.data.assignments.includes(item)).length;
    return { deleted: items.length - pending, pending };
  }
  finalizeDeletion(item) {
    if (!item.deletePending || item.needsCleanup || this.runs.has(item.id)) return false;
    const previous = this.state.data.assignments;
    if (!previous.includes(item)) return true;
    this.state.data.assignments = previous.filter(entry => entry !== item);
    try { this.state.save(); }
    catch (error) { this.state.data.assignments = previous; throw error; }
    for (const map of [this.statuses, this.sessionEnds, this.telemetryStatuses, this.telemetryClients, this.retryAt]) map.delete(item.id);
    this.record('assignment_deleted', { assignmentId: item.id, accountId: item.accountId, serverId: item.serverId });
    return true;
  }
  async stopAccount(id) {
    await this.stopMany(this.state.data.assignments.filter(item => item.accountId === id), false, 'account_logout');
  }
  release(run, reason, authResponse = null) {
    if (!run.stopping) {
      run.ticketContext.reason = reason;
      this.sessionEnds.set(run.identity.assignmentId, { reason, authResponse, at: new Date().toISOString() });
      this.record('assignment_lease_released', { ...run.identity, leaseId: run.leaseId,
        attemptId: run.attemptId, ticketFingerprint: run.ticketFingerprint, reason, authResponse,
        authenticated: run.authenticated, connectedMs: run.registeredAt ? Date.now() - run.registeredAt : 0 });
    }
    run.stopping = true;
    run.telemetryController?.abort();
    run.hold.resolve();
  }
  onEvent(serverId, event) {
    for (const item of this.state.data.assignments) {
      if (item.serverId !== serverId || item.steamId !== event.steamId) continue;
      const run = this.runs.get(item.id);
      if (!run || run.stopping || !run.registeredAt || event.timestamp * 1000 < run.registeredAt - 1000) continue;
      if (event.event === 'steam_auth_ok') {
        if (!run.authenticated) run.authenticatedAt = new Date().toISOString();
        run.authenticated = true;
        this.setStatus(item.id, 'authenticated');
      } else if (event.event === 'steam_auth_lost') {
        this.record('assignment_auth_lost', { assignmentId: item.id, accountId: item.accountId,
          serverId, attemptId: run.attemptId, ticketFingerprint: run.ticketFingerprint,
          association: 'current_attempt_unverified', authResponse: event.authResponse || null });
        run.authenticated = false;
        this.setStatus(item.id, 'renewing', 'Steam 认证失效，正在结束旧会话并重新申请票据。');
        this.release(run, 'steam_auth_lost', event.authResponse || null);
      }
    }
    if (['plugin_init', 'bot_unregistered', 'bot_respawn_failed'].includes(event.event)) this.schedule(serverId);
  }
  schedule(serverId) {
    if (this.closed) return;
    queueMicrotask(() => this.sync(serverId).catch(() => {}));
  }
  tick() {
    if (this.closed) return;
    for (const server of this.state.data.servers) {
      if (this.hub.connected(server.id)) this.schedule(server.id);
      else {
        const since = this.hub.view(server.id).disconnectedAt || Date.now();
        for (const item of this.state.data.assignments.filter(item => item.serverId === server.id)) {
          const run = this.runs.get(item.id);
          if (run && Date.now() - since > this.offlineGraceMs) this.release(run, 'plugin_offline_timeout');
          this.setStatus(item.id, item.needsCleanup && !item.enabled ? 'cleanup_pending' : 'waiting_server');
        }
      }
    }
  }
  async sync(serverId) {
    if (this.closed || !this.hub.connected(serverId)) return;
    if (this.syncing.has(serverId)) {
      this.resync.add(serverId);
      return this.syncing.get(serverId);
    }
    const task = (async () => {
      do {
        this.resync.delete(serverId);
        try { await this.syncOnce(serverId); }
        catch (error) {
          for (const item of this.state.data.assignments.filter(item => item.serverId === serverId)) {
            if (!this.runs.get(item.id)?.authenticated) this.setStatus(item.id, 'uncertain', safeError(error));
          }
          break;
        }
      } while (this.resync.has(serverId) && this.hub.connected(serverId) && !this.closed);
    })();
    this.syncing.set(serverId, task);
    try { await task; }
    finally {
      this.syncing.delete(serverId);
      // A ticket can finish issuance after the do/while condition was checked
      // but before this task's finally runs. Do not lose that resync request.
      if (this.resync.delete(serverId)) this.schedule(serverId);
    }
  }
  async syncOnce(serverId) {
    const bots = await this.hub.reconcile(serverId);
    for (const item of this.state.data.assignments.filter(item => item.serverId === serverId)) {
      if (this.closed) return;
      const run = this.runs.get(item.id);
      const bot = bots.find(bot => bot.steamId === item.steamId);
      if (run) {
        if (run.stopping || !run.ticket) continue;
        if (!item.enabled) { this.release(run, 'assignment_disabled'); continue; }
        if (run.registeredAt && !run.authenticated && Date.now() - run.registeredAt > this.authTimeoutMs) {
          this.record('assignment_auth_timeout', { assignmentId: item.id, accountId: item.accountId,
            serverId, elapsedMs: Date.now() - run.registeredAt });
          this.setStatus(item.id, 'renewing', '等待 Steam 最终认证超时，正在重新建立会话。');
          this.release(run, 'steam_auth_timeout');
          continue;
        }
        if (!bot) {
          if (run.registeredAt) this.record('assignment_entity_missing', { assignmentId: item.id,
            accountId: item.accountId, serverId, connectedMs: Date.now() - run.registeredAt,
            authenticated: run.authenticated });
          await this.stopTelemetry(run);
          await this.register(item, run);
        }
        else {
          run.remoteCreated = true;
          this.setStatus(item.id, run.authenticated ? 'authenticated' : 'waiting_auth');
          this.startTelemetry(item, run);
        }
        continue;
      }
      // Never assume an entity surviving a controller restart belongs to a new
      // Steam lease. Remove only this controller's recorded identity first.
      if (bot) {
        item.needsCleanup = true;
        this.state.save();
        try { await this.hub.command(serverId, 'unregister_bot', { steam_id: item.steamId,
          reason: item.deletePending ? 'pending_delete_cleanup' : item.enabled ? 'orphan_recovery_cleanup' : 'stopped_assignment_cleanup' }); }
        catch (error) {
          if (!item.deletePending) throw error;
          this.setStatus(item.id, 'cleanup_pending', safeError(error));
          continue;
        }
      }
      item.needsCleanup = false;
      if (this.finalizeDeletion(item)) continue;
      this.state.save();
      if (!item.enabled) { this.setStatus(item.id, 'stopped'); continue; }
      const account = this.accounts.accounts.get(item.accountId);
      if (account?.state !== 'online' || !account.features) { this.setStatus(item.id, 'waiting_steam'); continue; }
      if ((this.retryAt.get(item.id) || 0) > Date.now()) continue;
      this.openLease(item, account);
    }
  }
  startTelemetry(item, run) {
    if (!this.telemetryEnabled) return;
    if (run.telemetry || run.stopping || this.closed) return;
    const account = this.accounts.accounts.get(item.accountId);
    const view = this.hub.view(item.serverId);
    if (account?.state !== 'online' || !account.features?.analytics || !view.info) return;
    const session = this.connectionSession(item, run);
    run.telemetryController = new AbortController();
    run.telemetry = this.createTelemetry({ ...this.telemetryOptions, tickets: account.features.analytics,
      log: this.createTelemetryLog({ accountId: item.accountId, assignmentId: item.id, serverId: item.serverId,
        steamId: item.steamId, displayName: item.displayName }),
      steamId: item.steamId, signal: run.telemetryController.signal, session,
      onStatus: status => this.telemetryStatuses.set(item.id, status),
      context: () => {
        if (run.stopping || this.closed || account.state !== 'online' || !this.hub.connected(item.serverId)) return null;
        const current = this.hub.view(item.serverId);
        return { info: current.info, endpoint: resolveGameEndpoint(this.state.server(item.serverId), current),
          bot: current.bots?.find(bot => bot.steamId === item.steamId), serverSessionId: session.serverSessionId,
          serverIndex: session.serverIndex };
      },
    });
  }
  connectionSession(item, run) {
    if (run.telemetrySession) return run.telemetrySession;
    let client = this.telemetryClients.get(item.id);
    if (!client) {
      client = { id: randomUUID().replaceAll('-', ''), startedAt: run.registeredAt || Date.now(), serverIndex: 0 };
      this.telemetryClients.set(item.id, client);
    }
    client.serverIndex++;
    run.telemetrySession = { ...client, serverSessionId: randomUUID().replaceAll('-', ''),
      connectedAt: run.registeredAt || Date.now() };
    return run.telemetrySession;
  }
  async stopTelemetry(run) {
    run.telemetryController?.abort();
    if (run.telemetry) await run.telemetry.stop();
    run.telemetry = null;
  }
  openLease(item, account) {
    const hold = deferred();
    const run = { hold, ticket: null, authenticated: false, stopping: false, remoteCreated: false, registeredAt: 0,
      leaseId: randomUUID(),
      identity: { assignmentId: item.id, accountId: item.accountId, serverId: item.serverId } };
    run.ticketContext = { ...run.identity, leaseId: run.leaseId, reason: 'lease_callback_finished' };
    this.runs.set(item.id, run);
    this.setStatus(item.id, 'issuing_ticket');
    run.done = (async () => {
      let failed = false;
      try {
        await account.features.rustAuth.withSessionTicket(async ({ sessionTicket, steamId, signal }) => {
          if (run.stopping || signal.aborted || this.closed) return;
          run.ticket = sessionTicket;
          run.ticketFingerprint = ticketFingerprint(sessionTicket);
          item.steamId = steamId;
          this.state.save();
          const abort = () => this.release(run, 'game_ticket_aborted');
          signal.addEventListener('abort', abort, { once: true });
          this.schedule(item.serverId);
          try { await hold.promise; }
          finally {
            run.stopping = true;
            signal.removeEventListener('abort', abort);
            // Finish WebAPI-ticket cleanup before the existing game lease can
            // cancel its app tickets. The two ticket types never outlive this lease.
            await this.stopTelemetry(run);
            // Serialize teardown after any potentially in-flight register. An
            // unknown register result is reconciled before the next new lease.
            try { await run.command; } catch {}
            if (item.needsCleanup && this.hub.connected(item.serverId)) {
              try {
                const bots = await this.hub.reconcile(item.serverId);
                if (bots.some(bot => bot.steamId === item.steamId)) {
                  await this.hub.command(item.serverId, 'unregister_bot', { steam_id: item.steamId,
                    reason: run.ticketContext.reason });
                }
                item.needsCleanup = false;
                this.state.save();
              } catch { /* Keep the cleanup marker until the plugin returns. */ }
            }
            run.ticket = null;
          }
        }, run.ticketContext);
      } catch (error) {
        failed = true;
        this.setStatus(item.id, 'error', safeError(error));
      } finally {
        run.ticket = null;
        if (this.runs.get(item.id) === run) this.runs.delete(item.id);
        const reason = run.ticketContext.reason;
        const delayMs = reason === 'steam_auth_lost' ? Math.max(this.authLossRetryMs, failed ? this.errorRetryMs : 0)
          : failed ? this.errorRetryMs : this.retryMs;
        const retryAt = Date.now() + delayMs;
        this.retryAt.set(item.id, retryAt);
        if (item.enabled && !this.closed) this.record('assignment_retry_scheduled', { ...run.identity,
          leaseId: run.leaseId, reason, delayMs, retryAt: new Date(retryAt).toISOString() });
        if (!failed) this.setStatus(item.id, item.needsCleanup ? 'cleanup_pending' : item.enabled ? 'renewing' : 'stopped');
      }
    })();
  }
  async register(item, run) {
    if (run.stopping || !run.ticket || !item.enabled) return;
    // Set and persist the cleanup obligation before transmitting any ticket.
    item.needsCleanup = true;
    this.state.save();
    run.authenticated = false;
    run.authenticatedAt = null;
    run.registeredAt = Date.now();
    run.attemptId = randomUUID();
    run.ticketContext.attemptId = run.attemptId;
    this.record('assignment_auth_attempt', { ...run.identity, leaseId: run.leaseId, attemptId: run.attemptId,
      ticketFingerprint: run.ticketFingerprint });
    run.telemetrySession = null;
    this.setStatus(item.id, 'registering');
    const payload = { steam_id: item.steamId, name: item.displayName, ip: item.ip,
      ticket_hex: run.ticket.toString('hex'), auth_attempt_id: run.attemptId, noauth: false };
    run.command = this.hub.command(item.serverId, 'register_bot', payload);
    try {
      await run.command;
      run.remoteCreated = true;
      if (!run.stopping) this.setStatus(item.id, run.authenticated ? 'authenticated' : 'waiting_auth');
    } catch (error) {
      this.setStatus(item.id, 'uncertain', safeError(error));
      // A timeout/disconnect may follow successful creation. Keep the ticket
      // alive and query reconcile; never blindly resend register_bot.
      if (error instanceof ApiError && error.status === 502) this.release(run, 'plugin_register_rejected');
    } finally {
      payload.ticket_hex = '';
      run.command = null;
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    const runs = [...this.runs.values()];
    for (const run of runs) this.release(run, 'service_shutdown');
    await Promise.all(runs.map(run => run.done));
  }
}
