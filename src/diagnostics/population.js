import { randomUUID } from 'node:crypto';
import { ApiError } from '../util.js';
import { resolveGameEndpoint, resolveQueryEndpoint } from '../public-player-counts.js';
import { queryA2S } from './a2s.js';

const iso = at => new Date(at).toISOString();
const age = (at, value) => Number.isFinite(Date.parse(value)) ? Math.max(0, at - Date.parse(value)) : null;

export class PopulationDiagnostics {
  constructor({ state, hub, bindings, publicCounts, journal, query = queryA2S, intervalMs = 10000, now = Date.now, log = () => {} }) {
    Object.assign(this, { state, hub, bindings, publicCounts, journal, query, intervalMs, now, log });
    this.captures = new Map(); this.latest = new Map(); this.closed = false;
  }
  record(event, details) {
    const written = this.journal?.write(event, details);
    if (written === false) { try { this.log('population_log_error', { code: 'WRITE_FAILED' }); } catch {} }
  }
  start() {
    for (const server of this.state.data.servers) if (server.diagnosticsEnabled === true) this.activate(server.id);
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
    void this.tick();
  }
  activate(id) {
    const capture = { captureId: randomUUID(), startedAt: iso(this.now()), controller: new AbortController() };
    this.captures.set(id, capture);
    this.record('population_capture_started', { serverId: id, captureId: capture.captureId, intervalMs: this.intervalMs });
  }
  setEnabled(id, enabled) {
    if (this.closed) throw new ApiError(503, '服务正在停止。');
    if (typeof enabled !== 'boolean') throw new ApiError(400, '请指定是否开启人数诊断。');
    const server = this.state.server(id);
    server.diagnosticsEnabled = enabled; this.state.save();
    if (enabled && !this.captures.has(id)) this.activate(id);
    if (!enabled) this.stopCapture(id, 'user_stopped');
    void this.tick();
    return this.view(id);
  }
  stopCapture(id, reason) {
    const capture = this.captures.get(id);
    if (!capture) return;
    capture.controller.abort(); this.captures.delete(id);
    this.record('population_capture_stopped', { serverId: id, captureId: capture.captureId, reason });
  }
  view(id) {
    const capture = this.captures.get(id);
    return { enabled: Boolean(capture), captureId: capture?.captureId || null,
      startedAt: capture?.startedAt || null, intervalMs: this.intervalMs, latest: this.latest.get(id) || null,
      logError: this.journal?.error || null };
  }
  async tick() {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      // Bound concurrency and serialize cycles even when an endpoint is slow.
      const entries = [...this.captures.entries()];
      for (let i = 0; i < entries.length && !this.closed; i += 4) {
        await Promise.all(entries.slice(i, i + 4).map(([id, capture]) => this.sample(id, capture).catch(() => {
          this.record('population_sample_failed', { serverId: id, captureId: capture.captureId, code: 'SAMPLE_FAILED' });
        })));
      }
    } finally { this.busy = false; }
  }
  async sample(id, capture) {
    const server = this.state.data.servers.find(item => item.id === id);
    if (!server) { this.stopCapture(id, 'server_removed'); this.latest.delete(id); return; }
    if (capture.controller.signal.aborted) return;
    const view = this.hub.view(id), at = this.now();
    const queryEndpoint = resolveQueryEndpoint(server, view);
    const population = this.bindings.population(id, view);
    const accounts = this.bindings.list().filter(item => item.serverId === id).map(item => ({
      assignmentId: item.id, accountId: item.accountId, steamId: item.steamId, enabled: item.enabled,
      phase: item.phase, leaseId: item.leaseId, authAttemptId: item.authAttemptId, ticketFingerprint: item.ticketFingerprint,
      ticketActive: item.ticketActive, steamAuthenticated: item.steamAuthenticated,
      steamAuthenticatedAt: item.steamAuthenticatedAt, lastSessionEnd: item.lastSessionEnd, retryAt: item.retryAt,
      telemetry: { status: item.facepunch?.status,
        startedAt: item.facepunch?.startedAt || null, connectionIndex: item.facepunch?.connectionIndex ?? null,
        lastPerformanceSampleAt: item.facepunch?.lastPerformanceSampleAt || null,
        lastPerformanceUploadedAt: item.facepunch?.lastPerformanceUploadedAt || null,
        lastUploadedPerformanceSampleAt: item.facepunch?.lastUploadedPerformanceSampleAt || null,
        performanceSampleAgeMs: age(at, item.facepunch?.lastPerformanceSampleAt),
        performanceUploadAgeMs: age(at, item.facepunch?.lastPerformanceUploadedAt),
        uploadedSampleAgeMs: age(at, item.facepunch?.lastUploadedPerformanceSampleAt) },
    }));
    const [a2s, external] = await Promise.all([
      queryEndpoint ? this.query(queryEndpoint, { signal: capture.controller.signal, now: this.now })
        : { status: 'waiting_address', code: 'query_endpoint_unavailable', players: null },
      this.publicCounts.query([{ id, endpoint: resolveGameEndpoint(server, view), population }]),
    ]);
    if (this.closed || this.captures.get(id) !== capture || capture.controller.signal.aborted) return;
    const sample = { serverId: id, captureId: capture.captureId, sampledAt: iso(at), completedAt: iso(this.now()),
      pluginConnected: view.connected === true, population, a2s, facepunch: external.servers[0], accounts };
    this.latest.set(id, sample);
    this.record('population_sample', sample);
  }
  close() {
    this.closed = true; clearInterval(this.timer);
    for (const id of this.captures.keys()) this.stopCapture(id, 'service_stopping');
  }
}
