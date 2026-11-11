import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { nativeObjects } from '../facepunch/native-events.js';

const EVENT_TYPES = new Set(['input_telemetry', 'client_performance', 'server_browser', 'world_prop_usage']);
const TABLES = new Set(['input_events', 'gameplay_events']);
const LIFECYCLE = new Set(['http_request', 'http_response', 'attempt_failed', 'attempt_aborted', 'ticket_ready', 'ticket_cleanup']);
const LOG_NAME = /^events(?:\.\d+)?\.jsonl$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const metric = () => ({ count: 0, min: null, max: null, total: 0 });
function measure(target, value) {
  if (!Number.isSafeInteger(value) || value < 0) return;
  target.count++;
  target.min = target.min === null ? value : Math.min(target.min, value);
  target.max = target.max === null ? value : Math.max(target.max, value);
  target.total += value;
}
function increment(object, key) { object[key] = (object[key] || 0) + 1; }
function schema() {
  return { events: 0, dataFields: metric(), eventBytes: metric(), inputIntegers: metric(), invalidInputLayouts: 0 };
}
function mergeMetric(target, source) {
  if (!source.count) return;
  target.count += source.count;
  target.total += source.total;
  target.min = target.min === null ? source.min : Math.min(target.min, source.min);
  target.max = target.max === null ? source.max : Math.max(target.max, source.max);
}
function mergeEventTypes(target, source) {
  for (const [name, value] of Object.entries(source || {})) {
    const entry = target[name] ||= schema();
    entry.events += value.events;
    entry.invalidInputLayouts += value.invalidInputLayouts;
    mergeMetric(entry.dataFields, value.dataFields);
    mergeMetric(entry.eventBytes, value.eventBytes);
    mergeMetric(entry.inputIntegers, value.inputIntegers);
  }
}
function eventComparison(accounts, nativeTypes) {
  const backendTypes = {};
  for (const a of accounts) {
    for (const table of Object.values(a.tables)) mergeEventTypes(backendTypes, table.eventTypes);
  }
  const names = [...new Set([...Object.keys(nativeTypes), ...Object.keys(backendTypes)])].sort();
  return {
    correlated: false,
    note: '两侧是汇总样本，未按账号、会话或时间配对；差异不证明事件丢失或上传因果。',
    eventTypes: names.map(type => {
      const native = nativeTypes[type] || schema();
      const backend = backendTypes[type] || schema();
      const presence = native.events && backend.events ? 'present_in_both'
        : native.events ? 'native_only' : 'backend_only';
      return { type, presence, native, backend };
    }),
  };
}
function observe(types, event, bytes) {
  const data = event?.Data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const name = EVENT_TYPES.has(data.type) ? data.type : 'other';
  const entry = types[name] ||= schema();
  entry.events++;
  measure(entry.dataFields, Object.keys(data).length);
  measure(entry.eventBytes, bytes ?? Buffer.byteLength(JSON.stringify(event)));
  if (Array.isArray(data.inputs)) {
    measure(entry.inputIntegers, data.inputs.length);
    if (data.inputs.length % 4 || data.inputs.some(value => !Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
      entry.invalidInputLayouts++;
    }
  }
}

// Read a fixed-size snapshot, discard oversized lines before decoding them,
// and keep raw credentials inside this parser. No raw record enters a report.
export async function* snapshotLines(path, maxLineBytes = 16 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new Error('Invalid line limit');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular log file');
  if (!info.size) return;
  const stream = createReadStream(path, { end: info.size - 1, highWaterMark: 65536 });
  let parts = [], length = 0, oversized = false, number = 0;
  try {
    for await (const chunk of stream) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        if (!oversized && length + end - start > maxLineBytes) {
          parts = []; length = 0; oversized = true;
        }
        if (!oversized && end > start) {
          parts.push(chunk.subarray(start, end)); length += end - start;
        }
        if (newline === -1) break;
        number++;
        yield { number, oversized, terminated: true,
          text: oversized ? null : Buffer.concat(parts, length).toString('utf8').replace(/\r$/, '').replace(/^\uFEFF/, '') };
        parts = []; length = 0; oversized = false;
        start = newline + 1;
      }
    }
    if (length || oversized) yield { number: number + 1, oversized, terminated: false,
      text: oversized ? null : Buffer.concat(parts, length).toString('utf8').replace(/\r$/, '').replace(/^\uFEFF/, '') };
  } finally { stream.destroy(); }
}

async function discover(input) {
  const root = resolve(input);
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error('Log links are not supported');
  if (info.isFile()) return [root];
  if (!info.isDirectory()) throw new Error('Expected a file or log directory');
  const files = [];
  // Supported layout: logs/facepunch/<account>/events[.N].jsonl.
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && LOG_NAME.test(entry.name)) files.push(join(root, entry.name));
    else if (entry.isDirectory()) {
      for (const child of await readdir(join(root, entry.name), { withFileTypes: true })) {
        if (child.isFile() && LOG_NAME.test(child.name)) files.push(join(root, entry.name, child.name));
      }
    }
  }
  return files.sort();
}

function account(directory) {
  return { directory, files: [], records: 0, malformedLines: 0, incompleteTailLines: 0, oversizedLines: 0,
    duplicateRecords: 0, uncorrelatedRecords: 0, requestLimitReached: false, requests: new Map(), tables: {},
    issues: [], omittedIssues: 0 };
}
function table() {
  return { requests: 0, responses: 0, httpAccepted: 0, httpRejected: 0, statusCodes: {},
    withoutResponse: 0, failuresBeforeAcceptance: 0, cleanupFailuresAfterAcceptance: 0, aborted: 0,
    steamAckMissing: 0, cleanupConfirmed: 0, cleanupUnconfirmed: 0, cleanupNotObserved: 0,
    fullBodies: 0, missingBodies: 0, jsonHashVerified: 0, jsonHashMismatch: 0, jsonHashUnavailable: 0,
    uncompressedSizeVerified: 0, uncompressedSizeMismatch: 0, sizeUnavailable: 0,
    uncompressedBytes: metric(), compressedBytes: metric(), durationMs: metric(),
    responseTruncated: 0, responseReadErrors: 0, eventTypes: {} };
}
function issue(a, file, line, code) {
  if (a.issues.length < 50) a.issues.push({ file: basename(file), line, code });
  else a.omittedIssues++;
}

function record(a, row, file, line, maxRequests) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) { a.malformedLines++; return; }
  a.records++;
  if (!LIFECYCLE.has(row.event)) return;
  const name = TABLES.has(row.table) ? row.table : 'other';
  const stats = a.tables[name] ||= table();
  let request;
  if (typeof row.requestId === 'string' && row.requestId.length <= 256 && row.requestId.length > 0) {
    const key = name + ':' + sha(row.requestId);
    request = a.requests.get(key);
    if (!request && a.requests.size >= maxRequests) {
      a.requestLimitReached = true;
      return;
    }
    if (!request) { request = { table: name, seen: new Set() }; a.requests.set(key, request); }
    if (request.seen.has(row.event)) { a.duplicateRecords++; return; }
    request.seen.add(row.event);
  } else { a.uncorrelatedRecords++; }

  if (row.event === 'ticket_ready' && row.steamAcknowledged === false) stats.steamAckMissing++;
  if (row.event === 'ticket_cleanup') {
    if (row.acknowledged === true) stats.cleanupConfirmed++;
    else stats.cleanupUnconfirmed++;
  }
  if (row.event === 'attempt_failed') {
    if (row.accepted === true) stats.cleanupFailuresAfterAcceptance++;
    else stats.failuresBeforeAcceptance++;
  }
  if (row.event === 'attempt_aborted') stats.aborted++;
  if (row.event === 'http_response') {
    stats.responses++;
    if (Number.isInteger(row.status) && row.status >= 100 && row.status <= 599) {
      increment(stats.statusCodes, String(row.status));
      if (row.status >= 200 && row.status < 300) stats.httpAccepted++;
      else stats.httpRejected++;
    }
    measure(stats.durationMs, row.durationMs);
    if (row.truncated === true) stats.responseTruncated++;
    if (row.readError) stats.responseReadErrors++;
  }
  if (row.event !== 'http_request') return;
  stats.requests++;
  measure(stats.uncompressedBytes, row.uncompressedBytes);
  measure(stats.compressedBytes, row.compressedBytes);
  if (!Array.isArray(row.body)) { stats.missingBodies++; issue(a, file, line, 'request_body_not_logged'); return; }
  stats.fullBodies++;
  const json = JSON.stringify(row.body);
  // A body containing masked values no longer has the original wire hash.
  if (json.includes('[REDACTED]')) { stats.jsonHashUnavailable++; stats.sizeUnavailable++; }
  else {
    if (typeof row.jsonSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(row.jsonSha256)) stats.jsonHashUnavailable++;
    else if (sha(json) === row.jsonSha256.toLowerCase()) stats.jsonHashVerified++;
    else { stats.jsonHashMismatch++; issue(a, file, line, 'json_hash_mismatch'); }
    if (!Number.isSafeInteger(row.uncompressedBytes) || row.uncompressedBytes < 0) stats.sizeUnavailable++;
    else if (Buffer.byteLength(json) === row.uncompressedBytes) stats.uncompressedSizeVerified++;
    else { stats.uncompressedSizeMismatch++; issue(a, file, line, 'json_byte_count_mismatch'); }
  }
  for (const event of row.body) observe(stats.eventTypes, event);
}

export async function auditLogs(input, { nativePath, maxLineBytes = 16 * 1024 * 1024, maxRequests = 100000 } = {}) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error('Invalid request limit');
  const files = await discover(input);
  const accounts = new Map();
  for (const file of files) {
    const directory = dirname(file);
    const a = accounts.get(directory) || account(directory);
    accounts.set(directory, a);
    a.files.push(basename(file));
    for await (const line of snapshotLines(file, maxLineBytes)) {
      if (line.oversized) { a.oversizedLines++; issue(a, file, line.number, 'line_size_limit'); continue; }
      if (!line.text.trim()) continue;
      let row;
      try { row = JSON.parse(line.text); }
      catch {
        if (!line.terminated) { a.incompleteTailLines++; issue(a, file, line.number, 'incomplete_tail'); }
        else { a.malformedLines++; issue(a, file, line.number, 'invalid_json'); }
        continue;
      }
      record(a, row, file, line.number, maxRequests);
    }
  }
  const result = [];
  for (const a of accounts.values()) {
    for (const request of a.requests.values()) {
      const stats = a.tables[request.table];
      if (!request.seen.has('http_request')) continue;
      if (!request.seen.has('http_response')) stats.withoutResponse++;
      if (!request.seen.has('ticket_cleanup')) stats.cleanupNotObserved++;
    }
    const { requests, ...published } = a;
    result.push(published);
  }
  let native = null;
  if (nativePath) {
    native = { eventTypes: {}, malformedAppends: 0, oversizedLines: 0 };
    for await (const line of snapshotLines(nativePath, maxLineBytes)) {
      if (line.oversized) { native.oversizedLines++; continue; }
      try { for (const item of nativeObjects(line.text)) observe(native.eventTypes, item.event, item.bytes); }
      catch { native.malformedAppends++; }
    }
  }
  const comparison = native ? eventComparison(result, native.eventTypes) : null;
  return { formatVersion: 1, generatedAt: new Date().toISOString(), source: resolve(input),
    summary: { files: files.length, accounts: result.length, records: result.reduce((sum, a) => sum + a.records, 0),
      requests: result.reduce((sum, a) => sum + Object.values(a.tables).reduce((s, t) => s + t.requests, 0), 0),
      httpAccepted: result.reduce((sum, a) => sum + Object.values(a.tables).reduce((s, t) => s + t.httpAccepted, 0), 0) },
    accounts: result, native, comparison,
    limits: ['Only local files are read. No Steam login or network request is performed.',
      'HTTP 2xx is transport acceptance, not confirmation of a game connection or public player count.',
      'No response in retained logs can mean a network failure, an unfinished attempt, or rotated history.',
      'Native and backend samples can cover different accounts, stages and time ranges.',
      'Reported compressed sizes come from the log; compressed wire bodies are not reconstructed.',
      'Raw bodies, headers, credentials and error messages are excluded; log directory paths remain for locating files.'] };
}
