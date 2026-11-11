import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { SimulatedTelemetryData } from './simulated-data.js';
import { ApiError } from '../steam/errors.js';

const config = JSON.parse(readFileSync(new URL('./client-config.json', import.meta.url), 'utf8'));
export const FACEPUNCH_TELEMETRY_URL = config.url;
export const TELEMETRY_INTERVALS = Object.freeze({ inputMs: 60000, gameplayMs: 300000,
  performanceMs: 600000, firstPerformanceMs: 30000 });
const iso = value => new Date(value).toISOString();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function errorDetails(error) {
  return { name: String(error?.name || 'Error'), message: String(error?.message || 'Unknown error').slice(0, 2048),
    code: error?.code ?? null, cause: error?.cause ? { code: error.cause.code ?? null,
      message: String(error.cause.message || '').slice(0, 2048) } : null };
}
async function responsePreview(response, limit) {
  const result = { body: '', capturedBytes: 0, truncated: false, readError: null };
  if (!response.body) return result;
  const reader = response.body.getReader();
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = limit - result.capturedBytes;
      const bytes = Buffer.from(value);
      chunks.push(bytes.subarray(0, remaining));
      result.capturedBytes += Math.min(bytes.length, remaining);
      if (bytes.length > remaining || result.capturedBytes >= limit) {
        result.truncated = true;
        await reader.cancel();
        break;
      }
    }
  } catch (error) { result.readError = errorDetails(error); }
  finally { reader.releaseLock(); }
  result.body = Buffer.concat(chunks).toString('utf8');
  return result;
}

export class FacepunchTelemetry {
  constructor({ tickets, steamId, context, signal, onStatus = () => {}, fetchImpl = globalThis.fetch, log = null,
    apiKey = process.env.FACEPUNCH_API_KEY || config.apiKey || '',
    now = Date.now, inputMs = TELEMETRY_INTERVALS.inputMs, gameplayMs = TELEMETRY_INTERVALS.gameplayMs,
    performanceMs = TELEMETRY_INTERVALS.performanceMs, lifecycle = true,
    firstGameplayMs = Math.min(inputMs, gameplayMs, performanceMs, lifecycle ? TELEMETRY_INTERVALS.firstPerformanceMs : Infinity),
    timeoutMs = 15000, responseLimitBytes = 256 * 1024, profile = {}, session = {}, inputSource,
    maxGameplayEvents = 64, maxGameplayBytes = 512 * 1024 }) {
    Object.assign(this, { tickets, context, onStatus, fetchImpl, log, now, inputMs, gameplayMs, performanceMs, timeoutMs, responseLimitBytes });
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    Object.assign(this, { lifecycle, maxGameplayEvents, maxGameplayBytes });
    this.inputSource = inputSource || (profile.inputMode === 'none' ? () => null : null);
    this.performanceSampled = false;
    this.data = new SimulatedTelemetryData({ steamId, now, profile, session });
    this.lifecycleState = { browserQueued: false, worldQueued: false, worldMetadataMissing: false };
    this.controller = new AbortController();
    this.signal = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    this.signal.addEventListener('abort', () => clearTimeout(this.timer), { once: true });
    const at = now();
    this.startedAt = at;
    this.nextInput = at + inputMs;
    this.nextGameplay = lifecycle ? at : at + firstGameplayMs;
    this.nextPerformance = at + firstGameplayMs;
    this.waitUntil = 0;
    this.rateLimitUntil = 0;
    this.sent = 0;
    this.pending = new Map();
    this.failureCounts = { input_events: 0, gameplay_events: 0 };
    this.tables = Object.fromEntries(['input_events', 'gameplay_events'].map(type => [type,
      { sentBatches: 0, sentEvents: 0, lastEventTypes: [], lastAttemptAt: null, lastSuccessAt: null, lastHttpStatus: null, error: null }]));
    this.status = { status: 'scheduled', simulated: true,
      inputEncoding: inputSource ? 'four_int32_supplied_records'
        : profile.inputMode === 'none' ? 'disabled' : 'four_int32_neutral_placeholders',
      connectionIndex: session.serverIndex ?? 1,
      sentBatches: 0, lastAttemptAt: null, lastSuccessAt: null, lastHttpStatus: null, lastTable: null,
      steamAcknowledged: null, cleanupAcknowledged: null, error: null, startedAt: iso(at), lastRequestId: null };
    this.record('worker_started', { sessionId: this.data.sessionId, intervals: { inputMs, gameplayMs, performanceMs, firstGameplayMs },
      target: FACEPUNCH_TELEMETRY_URL, lifecycle, serverIndex: session.serverIndex ?? 1 });
    this.publish();
    this.schedule();
  }
  record(event, details = {}, secrets = []) {
    this.log?.write(event, { sessionId: this.data.sessionId, ...details }, { secrets });
  }
  nextDue() {
    return Math.max(this.waitUntil, this.rateLimitUntil, Math.min(this.nextInput, this.nextGameplay, this.nextPerformance,
      ...[...this.pending.values()].map(job => job.retryAt)));
  }
  publish(change = {}) {
    Object.assign(this.status, change);
    const stopped = this.signal.aborted;
    const tables = structuredClone(this.tables);
    for (const [type, table] of Object.entries(tables)) {
      const job = this.pending.get(type);
      const generation = type === 'input_events' ? this.nextInput
        : this.lifecycle && !this.lifecycleState.browserQueued ? this.startedAt : this.nextPerformance;
      const due = job ? job.retryAt : type === 'input_events' ? this.nextInput : Math.max(this.nextGameplay, generation);
      table.pendingEvents = job?.batch.length || 0;
      table.pendingEventTypes = [...new Set(job?.batch.map(event => event.Data.type) || [])];
      table.nextEventAt = stopped ? null : iso(Math.max(this.waitUntil, this.rateLimitUntil, generation));
      table.nextAttemptAt = stopped ? null : iso(Math.max(this.waitUntil, this.rateLimitUntil, due));
    }
    this.onStatus({ ...this.status, tables, uptimeMs: Math.max(0, this.now() - this.startedAt),
      lifecycle: { ...this.lifecycleState },
      logFile: this.log?.path || null, logError: this.log?.error || null,
      nextAttemptAt: stopped ? null : iso(this.nextDue()) });
  }
  schedule() {
    if (this.signal.aborted) return;
    this.timer = setTimeout(() => { void this.flush(); }, Math.max(1, this.nextDue() - this.now()));
    this.timer.unref?.();
  }
  async flush() {
    if (this.signal.aborted) return;
    if (this.inFlight) return this.inFlight;
    clearTimeout(this.timer);
    this.inFlight = this.flushOnce();
    try { await this.inFlight; }
    catch (error) {
      if (!this.signal.aborted) {
        this.waitUntil = this.now() + 60000;
        this.record('worker_error', { error: errorDetails(error), retryAt: iso(this.waitUntil) });
        this.publish({ status: 'error', error: '遥测数据生成失败，稍后自动重试。' });
      }
    }
    finally { this.inFlight = null; this.schedule(); }
  }
  enqueue(type, batch, at) {
    const previous = this.pending.get(type);
    // Input samples replace old input. Gameplay preserves connection events
    // while coalescing older unsent performance samples into the newest one.
    if (type === 'gameplay_events' && previous) {
      const replacesPerformance = batch.some(event => event.Data.type === 'client_performance');
      batch = [...previous.batch.filter(event => !replacesPerformance || event.Data.type !== 'client_performance'), ...batch];
    }
    if (type === 'gameplay_events' && (batch.length > this.maxGameplayEvents
      || Buffer.byteLength(JSON.stringify(batch)) > this.maxGameplayBytes)) {
      throw new Error('Gameplay event queue limit reached.');
    }
    const retryAt = previous ? Math.max(previous.retryAt, at) : type === 'gameplay_events' ? Math.max(at, this.nextGameplay) : at;
    this.pending.set(type, { batch, retryAt });
    this.record(previous ? 'batch_replaced' : 'batch_generated', { table: type, events: batch.length,
      eventTypes: batch.map(event => event.Data.type), eventGuids: batch.map(event => event.Data.guid),
      previousEventGuids: previous?.batch.map(event => event.Data.guid) || [], readyAt: iso(retryAt) });
  }
  async flushOnce() {
    const at = this.now();
    if (at < Math.max(this.waitUntil, this.rateLimitUntil)) return;
    const context = this.context();
    if (!context?.endpoint || !context?.bot) {
      this.waitUntil = at + Math.min(this.inputMs, this.gameplayMs);
      this.record('waiting_context', { endpointAvailable: Boolean(context?.endpoint), roleAvailable: Boolean(context?.bot), retryAt: iso(this.waitUntil) });
      this.publish({ status: 'waiting_context', error: '等待服务器地址与角色信息。' });
      return;
    }
    this.waitUntil = 0;
    if (this.lifecycle && !this.lifecycleState.browserQueued) {
      this.enqueue('gameplay_events', [this.data.serverBrowser(context)], at);
      this.lifecycleState.browserQueued = true;
    }
    if (at >= this.nextInput) {
      const supplied = this.inputSource ? await this.inputSource(context) : undefined;
      if (this.signal.aborted) return;
      const event = this.inputSource ? supplied ? this.data.inputPacked(supplied) : null : this.data.input();
      if (event) this.enqueue('input_events', [event], at);
      else this.record('table_idle', { table: 'input_events', reason: 'no_input_records' });
      this.nextInput = at + this.inputMs;
    }
    if (at >= this.nextPerformance) {
      const sampleContext = this.lifecycle && !this.performanceSampled
        && context.performance?.scenes === undefined && this.data.profile.performance?.scenes === undefined
        ? { ...context, performance: { ...context.performance, scenes: {} } } : context;
      this.enqueue('gameplay_events', [this.data.performance(sampleContext)], at);
      this.status.lastPerformanceSampleAt = iso(at);
      this.performanceSampled = true;
      this.nextPerformance = at + this.performanceMs;
    }
    if (at >= this.nextGameplay) {
      this.nextGameplay = at + this.gameplayMs;
      if (!this.pending.has('gameplay_events')) this.record('table_idle', {
        table: 'gameplay_events', reason: 'waiting_for_next_performance_sample', nextEventAt: iso(this.nextPerformance) });
    }
    for (const type of ['input_events', 'gameplay_events']) {
      if (this.signal.aborted) break;
      if (this.now() < this.rateLimitUntil) break;
      const job = this.pending.get(type);
      if (!job || this.now() < job.retryAt) continue;
      await this.sendBatch(type, job);
    }
    if (!this.signal.aborted && this.lifecycle && !this.lifecycleState.worldQueued) {
      const world = this.data.worldPropUsage(context);
      if (world) {
        this.enqueue('gameplay_events', [world], this.now());
        this.lifecycleState.worldQueued = true;
        this.lifecycleState.worldMetadataMissing = false;
      } else if (!this.lifecycleState.worldMetadataMissing) {
        this.lifecycleState.worldMetadataMissing = true;
        this.record('waiting_world_metadata', { reason: 'map_filename_and_required_props_not_available' });
      }
    }
    if (!this.signal.aborted) {
      const errors = Object.values(this.tables).filter(table => table.error);
      this.publish(errors.length ? { status: this.sent ? 'partial_error' : 'error', error: errors[0].error }
        : this.sent ? { status: 'accepted', error: null } : { status: 'scheduled', error: null });
    }
  }
  async sendBatch(type, job) {
    const { batch } = job;
    const json = JSON.stringify(batch);
    const body = gzipSync(Buffer.from(json, 'utf8'));
    const requestId = randomUUID();
    const attemptAt = this.now();
    const tableStatus = this.tables[type];
    Object.assign(tableStatus, { lastAttemptAt: iso(attemptAt), lastHttpStatus: null, error: null });
    this.publish({ status: 'sending', lastAttemptAt: iso(attemptAt), error: null, lastHttpStatus: null,
      lastTable: type, lastRequestId: requestId, steamAcknowledged: null, cleanupAcknowledged: null });
    let phase = 'configuration', accepted = false, retryAfter = null;
    const secrets = [this.apiKey];
    try {
      if (!this.apiKey) throw new ApiError(503, '未配置 Facepunch 应用密钥，请设置 FACEPUNCH_API_KEY 后重启控制端。');
      phase = 'ticket_request';
      this.record('ticket_requested', { requestId, table: type });
      const cleanup = await this.tickets.withTicket(async ({ ticket, steamId, steamAcknowledged }) => {
        this.signal.throwIfAborted();
        const token = ticket.toString('base64');
        secrets.push(token);
        this.record('ticket_ready', { requestId, table: type, steamAcknowledged });
        this.publish({ steamAcknowledged });
        const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip',
          'X-API-KEY': this.apiKey, STEAM_TOKEN: token, STEAM_TOKEN_VERSION: '1', STEAM_ID: steamId, TYPE: type };
        phase = 'http_request';
        const httpAt = this.now();
        this.record('http_request', { requestId, table: type, method: 'POST', url: FACEPUNCH_TELEMETRY_URL,
          headers, body: batch, uncompressedBytes: Buffer.byteLength(json), compressedBytes: body.length,
          jsonSha256: digest(Buffer.from(json)), gzipSha256: digest(body) }, secrets);
        const response = await this.fetchImpl(FACEPUNCH_TELEMETRY_URL, {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]), headers, body,
        });
        phase = 'http_response';
        const httpStatus = response.status;
        tableStatus.lastHttpStatus = httpStatus;
        retryAfter = response.headers?.get('retry-after');
        this.publish({ lastHttpStatus: httpStatus });
        const preview = await responsePreview(response, this.responseLimitBytes);
        this.record('http_response', { requestId, table: type, status: httpStatus, statusText: response.statusText,
          headers: Object.fromEntries(response.headers || []), durationMs: Math.max(0, this.now() - httpAt),
          ...preview }, secrets);
        if (httpStatus < 200 || httpStatus >= 300) throw new Error('HTTP rejected');
        accepted = true;
        this.sent++;
        tableStatus.sentBatches++;
        tableStatus.sentEvents += batch.length;
        tableStatus.lastEventTypes = [...new Set(batch.map(event => event.Data.type))];
        tableStatus.lastSuccessAt = iso(this.now());
        const performance = batch.filter(event => event.Data.type === 'client_performance');
        if (performance.length) {
          this.status.lastPerformanceUploadedAt = tableStatus.lastSuccessAt;
          this.status.lastUploadedPerformanceSampleAt = performance.at(-1).Timestamp;
        }
        this.failureCounts[type] = 0;
        this.pending.delete(type);
        this.publish({ status: 'accepted', sentBatches: this.sent, lastSuccessAt: tableStatus.lastSuccessAt });
        phase = 'ticket_cleanup';
      }, { signal: this.signal, requestId });
      this.record('ticket_cleanup', { requestId, table: type, acknowledged: cleanup?.cleanupAcknowledged ?? null,
        accepted, totalDurationMs: Math.max(0, this.now() - attemptAt) });
      this.publish({ cleanupAcknowledged: cleanup?.cleanupAcknowledged ?? null });
    } catch (error) {
      if (this.signal.aborted) {
        this.record('attempt_aborted', { requestId, table: type, phase, httpStatus: tableStatus.lastHttpStatus,
          error: errorDetails(error) }, secrets);
        return;
      }
      const failures = ++this.failureCounts[type];
      let retryAt = this.now() + Math.min(900000, 60000 * 2 ** Math.min(failures - 1, 4));
      if (tableStatus.lastHttpStatus === 429) {
        const seconds = Number(retryAfter);
        const advised = Number.isFinite(seconds) && seconds > 0 ? this.now() + seconds * 1000 : Date.parse(retryAfter);
        if (Number.isFinite(advised)) retryAt = Math.max(retryAt, advised);
        this.rateLimitUntil = retryAt;
      }
      if (!accepted) job.retryAt = retryAt;
      tableStatus.error = accepted ? 'Facepunch 已接收，专用票据清理未完成。' : error instanceof ApiError ? error.message
        : tableStatus.lastHttpStatus ? `Facepunch 返回 HTTP ${tableStatus.lastHttpStatus}，稍后自动重试。`
          : 'Facepunch 网络请求失败或超时，稍后自动重试。';
      this.record('attempt_failed', { requestId, table: type, phase, accepted, httpStatus: tableStatus.lastHttpStatus,
        consecutiveFailures: failures, retryAt: accepted ? null : iso(retryAt), error: errorDetails(error),
        summary: tableStatus.error }, secrets);
      this.publish({ status: accepted ? 'cleanup_error' : 'error', error: tableStatus.error });
    } finally { body.fill(0); }
  }
  async stop() {
    this.controller.abort();
    clearTimeout(this.timer);
    try { await this.inFlight; } catch { /* flush() records generation failures. */ }
    this.record('worker_stopped', { sentBatches: this.sent, tables: this.tables,
      discardedPendingTables: [...this.pending.keys()] });
    this.pending.clear();
    this.publish({ status: 'stopped' });
  }
}
