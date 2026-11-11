import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditLogs, snapshotLines } from '../src/diagnostics/log-audit.js';

const SECRET = 'PRIVATE_VALUE_MUST_NEVER_APPEAR_IN_REPORT';
const body = [{ Timestamp: '2026-10-31T12:00:00Z', Data: { type: 'input_telemetry', inputs: [0, 0, 0, 0], note: SECRET } }];
function request(requestId, changes = {}) {
  const json = JSON.stringify(body);
  return { event: 'http_request', table: 'input_events', requestId, headers: { STEAM_TOKEN: SECRET }, body,
    uncompressedBytes: Buffer.byteLength(json), compressedBytes: 60,
    jsonSha256: createHash('sha256').update(json).digest('hex'), ...changes };
}
function response(requestId, changes = {}) {
  return { event: 'http_response', table: 'input_events', requestId, status: 200, durationMs: 25,
    headers: { 'set-cookie': SECRET }, body: SECRET, ...changes };
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'controller-log-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function rows(path, values) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, values.map(v => JSON.stringify(v)).join('\n') + '\n');
}

test('rotation, duplicated records and identical request IDs in separate accounts remain correctly correlated', async t => {
  const directory = await temporary(t);
  await rows(join(directory, 'a', 'events.1.jsonl'), [request('same-id')]);
  await rows(join(directory, 'a', 'events.jsonl'), [request('same-id'), response('same-id'),
    { event: 'ticket_cleanup', requestId: 'same-id', table: 'input_events', acknowledged: true }]);
  await rows(join(directory, 'b', 'events.jsonl'), [request('same-id'), response('same-id', { status: 429 })]);
  const report = await auditLogs(directory);
  assert.deepEqual(report.summary, { files: 3, accounts: 2, records: 6, requests: 2, httpAccepted: 1 });
  const [a, b] = report.accounts;
  assert.equal(a.duplicateRecords, 1);
  assert.equal(a.tables.input_events.jsonHashVerified, 1);
  assert.equal(a.tables.input_events.uncompressedSizeVerified, 1);
  assert.equal(a.tables.input_events.cleanupConfirmed, 1);
  assert.equal(a.tables.input_events.withoutResponse, 0);
  assert.equal(b.tables.input_events.httpRejected, 1);
  assert.equal(b.tables.input_events.statusCodes['429'], 1);
  assert.equal(b.tables.input_events.cleanupNotObserved, 1);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('HTTP acceptance, failures before acceptance and cleanup failures are reported separately', async t => {
  const directory = await temporary(t);
  await rows(join(directory, 'events.jsonl'), [request('accepted'), response('accepted', { truncated: true, readError: SECRET }),
    { event: 'attempt_failed', requestId: 'accepted', table: 'input_events', accepted: true, error: { message: SECRET } },
    request('network'), { event: 'attempt_failed', requestId: 'network', table: 'input_events', accepted: false },
    { event: 'ticket_ready', requestId: 'network', table: 'input_events', steamAcknowledged: false },
    { event: 'ticket_cleanup', requestId: 'network', table: 'input_events', acknowledged: false }, request('pending')]);
  const report = await auditLogs(directory);
  const table = report.accounts[0].tables.input_events;
  assert.equal(table.httpAccepted, 1);
  assert.equal(table.failuresBeforeAcceptance, 1);
  assert.equal(table.cleanupFailuresAfterAcceptance, 1);
  assert.equal(table.withoutResponse, 2);
  assert.equal(table.cleanupUnconfirmed, 1);
  assert.equal(table.steamAckMissing, 1);
  assert.equal(table.responseReadErrors, 1);
  assert.equal(table.responseTruncated, 1);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('hash or byte-count mismatches and an unfinished tail are visible without publishing malformed content', async t => {
  const directory = await temporary(t);
  const file = join(directory, 'events.jsonl');
  const wrong = request('wrong', { jsonSha256: '0'.repeat(64), uncompressedBytes: 1 });
  await writeFile(file, JSON.stringify(wrong) + '\n' + 'invalid-' + SECRET + '\n' + '{"partial":"' + SECRET);
  const report = await auditLogs(file);
  const a = report.accounts[0];
  assert.equal(a.malformedLines, 1);
  assert.equal(a.incompleteTailLines, 1);
  assert.equal(a.tables.input_events.jsonHashMismatch, 1);
  assert.equal(a.tables.input_events.uncompressedSizeMismatch, 1);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('a redacted body is marked unverifiable instead of being called a corrupted wire body', async t => {
  const directory = await temporary(t);
  await rows(join(directory, 'events.jsonl'), [request('masked', {
    body: [{ Data: { type: 'client_performance', value: '[REDACTED]' } }],
  })]);
  const report = await auditLogs(directory);
  const table = report.accounts[0].tables.input_events;
  assert.equal(table.jsonHashUnavailable, 1);
  assert.equal(table.sizeUnavailable, 1);
  assert.equal(table.jsonHashMismatch, 0);
});

test('native comma-prefixed appends, nested objects and quoted braces parse while headers and stack traces are ignored', async t => {
  const directory = await temporary(t);
  const backend = join(directory, 'events.jsonl');
  await rows(backend, [request('one')]);
  const native = join(directory, 'native.log');
  const event = type => ({ Timestamp: '2026-10-31T12:00:00Z', Data: { type, detail: { note: 'a } , { " \\ ' + SECRET } } });
  await writeFile(native, 'STEAM_TOKEN: ' + SECRET + '\n[' + JSON.stringify(event('server_browser')) + '\nStackTrace()\n'
    + ',' + JSON.stringify(event('client_performance')) + '\n]\n'
    + JSON.stringify([event('input_telemetry'), event('world_prop_usage')]) + '\n');
  const report = await auditLogs(backend, { nativePath: native });
  assert.equal(report.native.malformedAppends, 0);
  assert.deepEqual(Object.keys(report.native.eventTypes).sort(), ['client_performance', 'input_telemetry', 'server_browser', 'world_prop_usage']);
  for (const value of Object.values(report.native.eventTypes)) assert.equal(value.events, 1);
  assert.equal(report.comparison.correlated, false);
  const comparison = Object.fromEntries(report.comparison.eventTypes.map(item => [item.type, item]));
  assert.equal(comparison.input_telemetry.presence, 'present_in_both');
  assert.equal(comparison.server_browser.presence, 'native_only');
  assert.equal(comparison.server_browser.backend.events, 0);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('oversized records are discarded and request correlation stays bounded', async t => {
  const directory = await temporary(t);
  const file = join(directory, 'events.jsonl');
  await writeFile(file, 'x'.repeat(200) + '\n' + JSON.stringify({ event: 'worker_started' }) + '\n');
  const lines = [];
  for await (const line of snapshotLines(file, 100)) lines.push(line);
  assert.equal(lines[0].oversized, true);
  assert.equal(lines[0].text, null);
  assert.equal(lines[1].oversized, false);
  await rows(file, [request('first'), request('second')]);
  const report = await auditLogs(file, { maxRequests: 1 });
  assert.equal(report.accounts[0].requestLimitReached, true);
  assert.equal(report.summary.requests, 1);
});

test('audit reads a snapshot without mutating input or using fetch; malformed native data is counted', async t => {
  const directory = await temporary(t);
  const file = join(directory, 'events.jsonl');
  await rows(file, [request('one')]);
  const original = await readFile(file);
  const native = join(directory, 'native.log');
  await writeFile(native, '[{"Timestamp":"unfinished-' + SECRET);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Network must not be used'); });
  const report = await auditLogs(file, { nativePath: native });
  assert.equal(report.native.malformedAppends, 1);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(await readFile(file), original);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('Windows-compatible CLI exports a safe report using the configured data directory', async t => {
  const directory = await temporary(t);
  await rows(join(directory, 'logs', 'facepunch', 'account', 'events.jsonl'), [request('one'), response('one')]);
  const script = fileURLToPath(new URL('../scripts/facepunch-log-audit.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CONTROLLER_DATA_DIR: directory } });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.summary.httpAccepted, 1);
  assert.ok(!child.stdout.includes(SECRET));
  const saved = await readFile(join(directory, 'diagnostics', 'facepunch-log-audit.json'), 'utf8');
  assert.ok(!saved.includes(SECRET));
  const reject = spawnSync(process.execPath, [script, join(directory, 'missing'), '--output', join(directory, 'package.log')],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(reject.status, 1);
});
