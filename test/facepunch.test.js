import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import SteamUser from 'steam-user';
import { AnalyticsTicket } from '../src/steam/webapi-ticket.js';
import { FacepunchTelemetry, FACEPUNCH_TELEMETRY_URL } from '../src/facepunch/telemetry.js';
import { SimulatedTelemetryData } from '../src/facepunch/simulated-data.js';
import { FacepunchLogStore, redactLog } from '../src/facepunch/log.js';

const APP = 252490;
const ID = '76561198000000001';
const identity = value => ({ getSteamID64: () => value });
function connection({ id = ID, ack = true, ackTimeoutMs = 100 } = {}) {
  const client = new EventEmitter();
  Object.assign(client, { steamID: identity(id), publicIP: '203.0.113.5', _authSeqMe: 0, _authSeqThem: 0,
    _connectTime: Date.now() - 1000, _connectionCount: 0, _hSteamPipe: 1,
    _gcTokens: Array.from({ length: 8 }, (_, i) => Buffer.alloc(32, i + 1)),
    _activeAuthTickets: [{ gameid: APP, steamid: 0, ticket_crc: 123, ticket: Buffer.from('existing game ticket') }],
    _handlerManager: { hasHandler: () => false, emit: () => {} } });
  let online = true;
  const sent = [];
  client.getAppOwnershipTicket = async () => ({ appOwnershipTicket: Buffer.from('synthetic signed ownership') });
  client._send = (emsg, body) => {
    assert.equal(emsg, SteamUser.EMsg.ClientAuthList);
    sent.push({ ...body, tickets: body.tickets.map(t => ({ ...t, ticket: Buffer.from(t.ticket),
      ...(t.server_secret ? { server_secret: Buffer.from(t.server_secret) } : {}) })) });
    // Deliberately deliver without a JobID, like current Steam's repeated ACKs.
    if (ack) setImmediate(() => client._handlerManager.emit(client, SteamUser.EMsg.ClientAuthListAck, {
      ticket_crc: body.tickets.map(t => t.ticket_crc), message_sequence: body.message_sequence,
    }));
  };
  const adapter = new AnalyticsTicket({ client, ackTimeoutMs,
    requireOnline: () => { if (!online) throw new Error('offline'); },
    parseTicket: () => ({ appID: APP, steamID: identity(id), hasValidSignature: true, isValid: true, isExpired: false }) });
  return { client, adapter, sent, offline() { online = false; adapter.disconnect(); } };
}
const context = () => ({ endpoint: '8.8.8.8:28015', serverSessionId: 'a'.repeat(32), bot: { alive: true },
  info: { world_size: 3500, world_seed: 42, map: 'Procedural Map', protocol: 2635 } });

test('analytics uses type 5, service identity, signed ownership and exact ticket cancellation alongside a game ticket', async () => {
  const { client, adapter, sent } = connection();
  const audit = []; adapter.log = details => audit.push(details);
  const game = client._activeAuthTickets[0];
  const remainingToken = client._gcTokens[1];
  let bytes;
  const result = await adapter.withTicket(async ({ ticket, steamId, steamAcknowledged }) => {
    bytes = ticket;
    assert.equal(steamId, ID);
    assert.equal(steamAcknowledged, true);
    assert.equal(ticket.length, 2560);
    const offset = 4 + ticket.readUInt32LE(0);
    assert.equal(ticket.readUInt32LE(offset), 24);
    assert.equal(ticket.readUInt32LE(offset + 8), 5);
    assert.equal(client._activeAuthTickets.length, 2);
    const auth = client._activeAuthTickets[1];
    assert.equal(auth.server_secret.toString(), 'str:analytics\0');
    assert.equal(ticket.readUInt32LE(auth.ticket.length), Buffer.byteLength('synthetic signed ownership'));
    assert.equal(ticket.subarray(auth.ticket.length + 4, auth.ticket.length + 4 + 26).toString(), 'synthetic signed ownership');
  });
  assert.equal(result.cleanupAcknowledged, true);
  assert.deepEqual(client._activeAuthTickets, [game]);
  assert.equal(game.ticket.toString(), 'existing game ticket');
  assert.equal(sent[0].tickets.length, 2);
  assert.equal(sent[1].tickets.length, 1);
  assert.ok(bytes.every(b => b === 0));
  assert.ok(remainingToken.some(b => b !== 0));
  assert.deepEqual(audit.filter(item => !item.operation.startsWith('auth_list_')).map(item => item.operation),
    ['issue_requested', 'issued', 'list_add_returned', 'cleanup_requested', 'cleanup_returned']);
  assert.ok(audit.every(item => item.ticketKind === 'analytics'));
  assert.equal(audit.at(-1).scope, undefined);
  assert.equal(audit.find(item => item.operation === 'cleanup_requested').scope, 'exact_analytics_entry');
  assert.equal(audit.at(-1).acknowledged, true);
  assert.equal(audit.at(-1).locallyRemoved, true);
  assert.match(audit[1].ticketFingerprint, /^[a-f0-9]{24}$/);
  assert.ok(!JSON.stringify(audit).includes('existing game ticket'));
  const lists = audit.filter(item => item.operation === 'auth_list_submitted');
  assert.deepEqual(lists.map(item => item.listedTickets.map(ticket => ticket.crc)), [[123, sent[0].tickets[1].ticket_crc], [123]]);
  assert.deepEqual(audit.filter(item => item.operation === 'auth_list_ack').map(item => item.acknowledgedCrcs),
    [[123, sent[0].tickets[1].ticket_crc], [123]]);
});

test('failed uploads, missing ACKs, parallel requests and late ownership results do not leak tickets', async () => {
  const f = connection();
  await assert.rejects(f.adapter.withTicket(async () => { throw new Error('transport'); }), /transport/);
  assert.equal(f.client._activeAuthTickets.length, 1);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const task = f.adapter.withTicket(async () => hold);
  await delay(5);
  await assert.rejects(f.adapter.withTicket(async () => {}), /仍在进行/);
  release(); await task;
  const unacked = connection({ ack: false, ackTimeoutMs: 5 });
  let observed;
  const result = await unacked.adapter.withTicket(async value => { observed = value.steamAcknowledged; });
  assert.equal(observed, false);
  assert.equal(result.cleanupAcknowledged, false);
  assert.equal(unacked.client._activeAuthTickets.length, 1);
  const late = connection();
  let finish;
  late.client.getAppOwnershipTicket = () => new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const aborted = late.adapter.withTicket(async () => assert.fail('Late ticket must not be uploaded'), { signal: controller.signal });
  controller.abort();
  finish({ appOwnershipTicket: Buffer.from('late ownership') });
  await assert.rejects(aborted);
  assert.equal(late.sent.length, 0);
  assert.equal(late.client._activeAuthTickets.length, 1);
});

test('two accounts obtain separate credentials and keep separate telemetry session identifiers', async () => {
  const a = connection(); const b = connection({ id: '76561198000000002' });
  const seen = [];
  await Promise.all([a, b].map(f => f.adapter.withTicket(async ({ ticket, steamId }) => seen.push({ steamId, ticket: Buffer.from(ticket) }))));
  assert.equal(new Set(seen.map(x => x.steamId)).size, 2);
  assert.notDeepEqual(seen[0].ticket, seen[1].ticket);
  const one = new SimulatedTelemetryData({ steamId: ID });
  const two = new SimulatedTelemetryData({ steamId: '76561198000000002' });
  const first = one.input(); const second = one.performance(context());
  assert.equal(first.Data.session_id, second.Data.session_id);
  assert.notEqual(first.Data.guid, second.Data.guid);
  assert.notEqual(first.Data.session_id, two.input().Data.session_id);
});

test('missing application key reports a configuration error without issuing tickets or HTTP requests', async t => {
  let ticketCalls = 0, httpCalls = 0;
  const statuses = [];
  const worker = new FacepunchTelemetry({ apiKey: '', steamId: ID, context,
    tickets: { withTicket: async () => { ticketCalls++; throw new Error('Unexpected ticket request'); } },
    fetchImpl: async () => { httpCalls++; throw new Error('Unexpected HTTP request'); },
    onStatus: value => statuses.push(value) });
  t.after(() => worker.stop());
  await worker.flush();
  assert.equal(ticketCalls, 0);
  assert.equal(httpCalls, 0);
  assert.equal(statuses.at(-1).status, 'error');
  assert.match(statuses.at(-1).error, /FACEPUNCH_API_KEY/);
  assert.equal(statuses.at(-1).sentBatches, 0);
});

test('scheduled batches reach an HTTP receiver with Facepunch URL, per-account headers, gzip and observed JSON types', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, headers: req.headers, batch: JSON.parse(gunzipSync(Buffer.concat(chunks))) });
    res.writeHead(204); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const f = connection();
  let clock = 100000;
  const statuses = [];
  const worker = new FacepunchTelemetry({ apiKey: 'synthetic-test-api-key', lifecycle: false, tickets: f.adapter, steamId: ID, context, now: () => clock,
    inputMs: 1000, gameplayMs: 5000, performanceMs: 10000, onStatus: s => statuses.push(s),
    fetchImpl: async (url, options) => {
      assert.equal(url, FACEPUNCH_TELEMETRY_URL);
      assert.equal(url, 'https://gw.facepunch.com/analytics/rust/client');
      return fetch(`http://127.0.0.1:${server.address().port}/`, options);
    } });
  t.after(() => worker.stop());
  await worker.flush(); assert.equal(requests.length, 0);
  clock += 1000; await worker.flush();
  clock += 9000; await worker.flush();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(r => r.headers.type), ['input_events', 'gameplay_events', 'input_events']);
  for (const r of requests) {
    assert.equal(r.method, 'POST');
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(r.headers.steam_id, ID);
    assert.equal(r.headers.steam_token_version, '1');
    assert.equal(Buffer.from(r.headers.steam_token, 'base64').length, 2560);
    assert.ok(r.headers['x-api-key']);
    assert.equal(r.batch.length, 1);
  }
  const input = requests[0].batch[0].Data;
  assert.equal(input.version, '4');
  assert.equal(input.inputs.length % 4, 0);
  assert.ok(input.inputs.every(x => Number.isInteger(x) && x >= -2147483648 && x <= 2147483647));
  const performance = requests[1].batch[0].Data;
  assert.equal(performance.type, 'client_performance');
  assert.equal(performance.server_address, context().endpoint);
  assert.equal(performance.world_seed, '42');
  assert.equal(typeof performance.frames, 'string');
  assert.equal(typeof performance.hardware, 'object');
  assert.equal(performance.session_id, input.session_id);
  assert.equal(f.client._activeAuthTickets.length, 1);
  assert.equal(statuses.at(-1).lastHttpStatus, 204);
  assert.equal(statuses.at(-1).sentBatches, 3);
  assert.equal(statuses.at(-1).tables.input_events.sentBatches, 2);
  assert.equal(statuses.at(-1).tables.gameplay_events.sentBatches, 1);
  assert.ok(!JSON.stringify(statuses).includes('STEAM_TOKEN'));
});

test('missing role or address prevents sending, and HTTP errors back off without reporting success', async () => {
  let clock = 100000, available = false, calls = 0;
  const statuses = [];
  const f = connection();
  const worker = new FacepunchTelemetry({ apiKey: 'synthetic-test-api-key', lifecycle: false, tickets: f.adapter, steamId: ID,
    context: () => available ? context() : null, now: () => clock, inputMs: 1000,
    onStatus: s => statuses.push(s), fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); } });
  clock += 1000; await worker.flush();
  assert.equal(calls, 0); assert.equal(statuses.at(-1).status, 'waiting_context');
  available = true; clock += 1000; await worker.flush();
  assert.equal(calls, 1); assert.equal(statuses.at(-1).lastHttpStatus, 429);
  assert.equal(statuses.at(-1).sentBatches, 0);
  clock += 60000; await worker.flush(); assert.equal(calls, 1);
  await worker.stop();
  clock += 120000; await worker.flush(); assert.equal(calls, 1);
  assert.equal(f.client._activeAuthTickets.length, 1);
});

test('stopping aborts an in-flight HTTP request, cancels only analytics and wipes its ticket', async () => {
  const f = connection();
  let clock = 100000, started;
  const ready = new Promise(resolve => { started = resolve; });
  const worker = new FacepunchTelemetry({ apiKey: 'synthetic-test-api-key', lifecycle: false, tickets: f.adapter, steamId: ID, context, now: () => clock, inputMs: 1000,
    fetchImpl: async (url, options) => {
      started();
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    } });
  clock += 1000;
  const pending = worker.flush();
  await ready; assert.equal(f.client._activeAuthTickets.length, 2);
  await worker.stop(); await pending;
  assert.equal(worker.status.status, 'stopped');
  assert.equal(worker.status.sentBatches, 0);
  assert.equal(f.client._activeAuthTickets.length, 1);
  assert.equal(f.client._activeAuthTickets[0].ticket.toString(), 'existing game ticket');
});

test('first gameplay batch is sent with the first minute, later samples retain the ten-minute cadence', async t => {
  let clock = 1000000;
  const f = connection(), requests = [], states = [];
  const worker = new FacepunchTelemetry({ apiKey: 'synthetic-test-api-key', lifecycle: false, tickets: f.adapter, steamId: ID, context, now: () => clock,
    onStatus: s => states.push(s), fetchImpl: async (url, options) => {
      requests.push({ type: options.headers.TYPE, batch: JSON.parse(gunzipSync(options.body)), at: clock });
      return new Response(null, { status: 200 });
    } });
  t.after(() => worker.stop());
  await worker.flush(); assert.equal(requests.length, 0);
  clock += 60000; await worker.flush();
  assert.deepEqual(requests.map(r => r.type), ['input_events', 'gameplay_events']);
  assert.equal(requests[1].batch[0].Data.total_time, '60');
  assert.equal(states.at(-1).tables.gameplay_events.nextEventAt, new Date(clock + 600000).toISOString());
  clock += 300000; await worker.flush();
  assert.equal(requests.filter(r => r.type === 'gameplay_events').length, 1, 'No empty gameplay batch at five-minute check');
  clock += 300000; await worker.flush();
  const performance = requests.filter(r => r.type === 'gameplay_events');
  assert.equal(performance.length, 2);
  assert.equal(performance[1].batch[0].Data.total_time, '600');
});

test('input failure does not suppress gameplay and each table retains an independent retry', async t => {
  let clock = 1000000;
  const f = connection(), requests = [], states = [];
  const worker = new FacepunchTelemetry({ apiKey: 'synthetic-test-api-key', lifecycle: false, tickets: f.adapter, steamId: ID, context, now: () => clock,
    onStatus: s => states.push(s), fetchImpl: async (url, options) => {
      requests.push(options.headers.TYPE);
      return new Response('diagnostic response', { status: options.headers.TYPE === 'input_events' ? 503 : 200 });
    } });
  t.after(() => worker.stop());
  clock += 60000; await worker.flush();
  assert.deepEqual(requests, ['input_events', 'gameplay_events']);
  assert.equal(states.at(-1).status, 'partial_error');
  assert.equal(states.at(-1).tables.gameplay_events.sentBatches, 1);
  assert.equal(states.at(-1).tables.input_events.pendingEvents, 1);
  clock += 60000; await worker.flush();
  assert.deepEqual(requests, ['input_events', 'gameplay_events', 'input_events']);
});

test('failed gameplay is retried a minute later with its retained event rather than dropped for ten minutes', async t => {
  let clock = 1000000;
  const f = connection(), gameplay = [], states = [];
  const worker = new FacepunchTelemetry({ apiKey: 'synthetic-test-api-key', lifecycle: false, tickets: f.adapter, steamId: ID, context, now: () => clock,
    onStatus: s => states.push(s), fetchImpl: async (url, options) => {
      if (options.headers.TYPE === 'gameplay_events') {
        gameplay.push(JSON.parse(gunzipSync(options.body)));
        if (gameplay.length === 1) return new Response('temporary error', { status: 500 });
      }
      return new Response(null, { status: 200 });
    } });
  t.after(() => worker.stop());
  clock += 60000; await worker.flush();
  assert.equal(states.at(-1).tables.gameplay_events.pendingEvents, 1);
  clock += 59999; await worker.flush(); assert.equal(gameplay.length, 1);
  clock += 1; await worker.flush();
  assert.equal(gameplay.length, 2);
  assert.equal(gameplay[0][0].Data.guid, gameplay[1][0].Data.guid);
  assert.equal(states.at(-1).tables.gameplay_events.sentBatches, 1);
  assert.equal(states.at(-1).tables.gameplay_events.pendingEvents, 0);
});

test('429 pauses both tables for Retry-After and preserves the gameplay batch until sending resumes', async t => {
  let clock = 1000000;
  const requests = [], states = [], f = connection();
  const worker = new FacepunchTelemetry({ apiKey: 'synthetic-test-api-key', lifecycle: false, tickets: f.adapter, steamId: ID, context, now: () => clock,
    onStatus: s => states.push(s), fetchImpl: async (url, options) => {
      requests.push(options.headers.TYPE);
      return requests.length === 1 ? new Response('limited', { status: 429, headers: { 'retry-after': '120' } })
        : new Response(null, { status: 200 });
    } });
  t.after(() => worker.stop());
  clock += 60000; await worker.flush(); assert.deepEqual(requests, ['input_events']);
  assert.equal(states.at(-1).tables.gameplay_events.pendingEvents, 1);
  clock += 119999; await worker.flush(); assert.equal(requests.length, 1);
  clock += 1; await worker.flush();
  assert.deepEqual(requests, ['input_events', 'input_events', 'gameplay_events']);
  assert.equal(states.at(-1).tables.gameplay_events.sentBatches, 1);
});

function logDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'adminlogger-fp-log-'));
  t.after(() => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('per-account journals record actual JSON, response content, correlation IDs and cleanup while redacting credentials', async t => {
  const directory = logDirectory(t);
  let clock = 1000000;
  const store = new FacepunchLogStore({ directory, now: () => clock });
  const log = store.forAccount({ accountId: 'test-account', displayName: 'Test role', assignmentId: 'assignment-a', steamId: ID });
  const f = connection(), tokens = [], states = [];
  const worker = new FacepunchTelemetry({ apiKey: 'synthetic-test-api-key', lifecycle: false, tickets: f.adapter, steamId: ID, context, now: () => clock, log,
    onStatus: s => states.push(s), fetchImpl: async (url, options) => {
      tokens.push(options.headers.STEAM_TOKEN);
      return new Response(JSON.stringify({ result: 'ok', echoed: options.headers.STEAM_TOKEN }), {
        status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'upstream-id', 'set-cookie': 'private-cookie' } });
    } });
  clock += 60000; await worker.flush(); await worker.stop();
  const text = readFileSync(log.path, 'utf8'), lines = text.trim().split('\n').map(line => JSON.parse(line));
  const requests = lines.filter(r => r.event === 'http_request');
  const responses = lines.filter(r => r.event === 'http_response');
  assert.equal(requests.length, 2); assert.equal(responses.length, 2);
  assert.equal(requests[1].body[0].Data.type, 'client_performance');
  assert.equal(requests[0].headers.STEAM_TOKEN, '[REDACTED]');
  assert.equal(requests[0].headers['X-API-KEY'], '[REDACTED]');
  assert.ok(requests[0].compressedBytes < requests[0].uncompressedBytes);
  assert.equal(responses[0].requestId, requests[0].requestId);
  assert.equal(responses[0].status, 200);
  assert.equal(JSON.parse(responses[0].body).result, 'ok');
  assert.equal(JSON.parse(responses[0].body).echoed, '[REDACTED]');
  assert.equal(responses[0].headers['x-request-id'], 'upstream-id');
  assert.equal(responses[0].headers['set-cookie'], '[REDACTED]');
  assert.ok(tokens.every(token => !text.includes(token)));
  assert.equal(lines[0].event, 'worker_started');
  assert.equal(lines.at(-1).event, 'worker_stopped');
  assert.equal(lines.filter(r => r.event === 'ticket_cleanup').length, 2);
  assert.equal(states.at(-1).logFile, log.path);
  assert.equal(states.at(-1).logError, null);
});

test('journals bound response capture, record rejected response bodies and preserve detailed transport causes', async t => {
  let clock = 1000000, input = 0;
  const log = new FacepunchLogStore({ directory: logDirectory(t) }).forAccount({ accountId: 'bounded' });
  const f = connection();
  const worker = new FacepunchTelemetry({ apiKey: 'synthetic-test-api-key', lifecycle: false, tickets: f.adapter, steamId: ID, context, now: () => clock, log, responseLimitBytes: 64,
    fetchImpl: async (url, options) => {
      if (options.headers.TYPE === 'input_events') {
        input++;
        if (input === 1) return new Response('rejected:' + 'x'.repeat(1024), { status: 400 });
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('hostname lookup failed'), { code: 'ENOTFOUND' }) });
      }
      return new Response(null, { status: 204 });
    } });
  t.after(() => worker.stop());
  clock += 60000; await worker.flush();
  clock += 60000; await worker.flush();
  const lines = readFileSync(log.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const response = lines.find(r => r.event === 'http_response' && r.table === 'input_events');
  assert.equal(response.status, 400); assert.equal(response.capturedBytes, 64); assert.equal(response.truncated, true);
  assert.match(response.body, /^rejected:/);
  const failed = lines.filter(r => r.event === 'attempt_failed');
  assert.equal(failed[0].phase, 'http_response');
  assert.equal(failed.at(-1).error.cause.code, 'ENOTFOUND');
  assert.equal(failed.at(-1).phase, 'http_request');
});

test('account log files append across restarts, rotate within bounds, resist path traversal and report disk errors', async t => {
  const directory = logDirectory(t), identity = { accountId: '../account/../../unsafe' };
  const store = new FacepunchLogStore({ directory, maxFileBytes: 256, backups: 2 });
  const log = store.forAccount(identity);
  assert.ok(resolve(log.path).startsWith(resolve(directory) + sep));
  log.write('before_restart');
  store.forAccount(identity).write('after_restart');
  assert.match(readFileSync(log.path, 'utf8'), /before_restart/);
  assert.match(readFileSync(log.path, 'utf8'), /after_restart/);
  for (let i = 0; i < 20; i++) log.write('rotation', { number: i, body: 'x'.repeat(100) });
  assert.deepEqual(readdirSync(log.directory).sort(), ['events.1.jsonl', 'events.2.jsonl', 'events.jsonl']);
  for (const file of readdirSync(log.directory)) for (const line of readFileSync(join(log.directory, file), 'utf8').trim().split('\n')) assert.ok(JSON.parse(line));
  const badPath = join(directory, 'not-a-directory'); writeFileSync(badPath, 'file');
  const bad = new FacepunchLogStore({ directory: badPath }).forAccount({ accountId: 'blocked' });
  assert.equal(bad.write('event'), false); assert.match(bad.error, /日志文件写入失败/);
  assert.deepEqual(redactLog({ Authorization: 'Bearer private', message: 'Authorization: Bearer private' }), {
    Authorization: '[REDACTED]', message: 'Authorization: [REDACTED]' });
  let clock = 1000000;
  const f = connection(), states = [];
  const worker = new FacepunchTelemetry({ apiKey: 'synthetic-test-api-key', lifecycle: false, tickets: f.adapter, steamId: ID, context, now: () => clock, log: bad,
    onStatus: s => states.push(s), fetchImpl: async () => new Response(null, { status: 200 }) });
  clock += 60000; await worker.flush(); await worker.stop();
  assert.equal(states.at(-1).sentBatches, 2, 'Log write failure must not stop otherwise valid uploads');
  assert.match(states.at(-1).logError, /日志文件写入失败/);
});
