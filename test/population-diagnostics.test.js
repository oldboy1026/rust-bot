import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { queryA2S } from '../src/diagnostics/a2s.js';
import { PopulationDiagnostics } from '../src/diagnostics/population.js';
import { resolveQueryEndpoint, gameSettings, PublicPlayerCounts } from '../src/public-player-counts.js';
import { authResponse, authDiagnostic, ticketFingerprint } from '../src/diagnostics/auth.js';

const packet = ({ players = 17, bots = 4 } = {}) => Buffer.concat([
  Buffer.from('ffffffff4911', 'hex'), Buffer.from('Test\0Map\0rust\0Rust\0'),
  Buffer.from([0x4a, 0xda, players, 200, bots, 100, 108, 0, 1]), Buffer.from('1.0\0'),
]);
async function udp(t, handler) {
  const socket = createSocket('udp4');
  socket.on('message', (bytes, sender) => handler(bytes, reply => socket.send(reply, sender.port, sender.address)));
  socket.bind(0, '127.0.0.1'); await once(socket, 'listening');
  t.after(() => new Promise(resolve => socket.close(resolve)));
  return { host: '127.0.0.1', port: socket.address().port };
}
test('A2S handles a real UDP challenge exchange and preserves players and bots as separate fields', async t => {
  let calls = 0;
  const endpoint = await udp(t, (bytes, reply) => {
    calls++;
    assert.equal(bytes[4], 0x54);
    if (calls === 1) reply(Buffer.from('ffffffff4101020304', 'hex'));
    else { assert.equal(bytes.subarray(-4).toString('hex'), '01020304'); reply(packet()); }
  });
  const result = await queryA2S(endpoint);
  assert.equal(calls, 2); assert.equal(result.status, 'ok');
  assert.equal(result.players, 17); assert.equal(result.bots, 4); assert.equal(result.maxPlayers, 200);
  assert.ok(Date.parse(result.sampledAt));
});
test('A2S timeout, malformed/split packets and aborts remain unknown instead of zero', async t => {
  for (const [bytes, code] of [[Buffer.from([1]), 'malformed_reply'],
    [Buffer.from('feffffff00000000', 'hex'), 'split_reply_unsupported'],
    [packet().subarray(0, -2), 'unsupported_or_malformed_reply']]) {
    const endpoint = await udp(t, (_bytes, reply) => reply(bytes));
    const result = await queryA2S(endpoint);
    assert.equal(result.status, 'error'); assert.equal(result.code, code); assert.equal(result.players, undefined);
  }
  const endpoint = await udp(t, () => {});
  assert.equal((await queryA2S(endpoint, { timeoutMs: 20 })).code, 'timeout');
  const controller = new AbortController();
  const waiting = queryA2S(endpoint, { signal: controller.signal });
  controller.abort(); assert.equal((await waiting).code, 'aborted');
  assert.equal((await queryA2S(endpoint, { signal: AbortSignal.abort() })).code, 'aborted');
});
test('query endpoint uses only the explicit or reported query port and supports NAT overrides', () => {
  const view = { info: { server_ip: '1.2.3.4', game_port: 28015, query_port: 28016 } };
  assert.deepEqual(resolveQueryEndpoint({}, view), { host: '1.2.3.4', port: 28016 });
  assert.deepEqual(resolveQueryEndpoint({ gameIp: '9.8.7.6', queryPort: 29016 }, view), { host: '9.8.7.6', port: 29016 });
  assert.equal(resolveQueryEndpoint({}, { info: { server_ip: '1.2.3.4', game_port: 28015 } }), null);
  assert.equal(gameSettings({ queryPort: '28016' }).queryPort, 28016);
  for (const value of [true, 0, 65536, '2e4']) assert.throws(() => gameSettings({ queryPort: value }), { status: 400 });
});
test('auth aliases and plugin diagnostic parsing retain useful evidence but drop secrets and arbitrary remote text', () => {
  assert.equal(authResponse('AuthTicketAlreadyUsed'), 'AuthTicketInvalidAlreadyUsed');
  assert.equal(authResponse('unknown-private-error'), null);
  const detail = authDiagnostic(JSON.stringify({ operation: 'validate_callback', response: 'AuthTicketAlreadyUsed',
    attemptId: '11111111-1111-4111-8111-111111111111', ticketFingerprint: ticketFingerprint(Buffer.from('synthetic-ticket')),
    ticket_hex: 'private', reason: 'private reason', association: 'exact_ticket', observedAt: '2026-11-11T01:00:00Z' }));
  assert.equal(detail.association, 'current_attempt_unverified');
  assert.equal(detail.response, 'AuthTicketInvalidAlreadyUsed');
  assert.equal(detail.ticketFingerprint.length, 24);
  assert.equal(JSON.stringify(detail).includes('private'), false);
  assert.equal(authDiagnostic('not-json'), null);
  assert.equal(authDiagnostic(JSON.stringify({ operation: 'arbitrary' })), null);
});
function collector(options = {}) {
  let at = 100000;
  const rows = [], server = { id: 'test', gameIp: '1.2.3.4', gamePort: 28015, queryPort: 28016, diagnosticsEnabled: false };
  const state = { data: { servers: [server] }, save() {}, server: () => server };
  const publicCounts = new PublicPlayerCounts({ now: () => at, fetchImpl: async () => new Response('{"1.2.3.4:28015":7}') });
  const diag = new PopulationDiagnostics({ state, publicCounts, now: () => at, intervalMs: 20,
    hub: { view: () => ({ connected: true }) }, bindings: {
      population: () => ({ pluginEntities: 17, steamAuthenticated: 17 }),
      list: () => [{ id: 'a', serverId: 'test', facepunch: { status: 'accepted',
        lastPerformanceSampleAt: new Date(at - 70000).toISOString(),
        lastPerformanceUploadedAt: new Date(at - 10000).toISOString(),
        lastUploadedPerformanceSampleAt: new Date(at - 70000).toISOString(), ticket_hex: 'private' } }],
    }, query: async () => ({ status: 'ok', players: 17, bots: 4 }),
    journal: { write(event, details) { rows.push({ event, ...details }); } }, ...options });
  return { diag, rows, server, advance(ms) { at += ms; } };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); }
  assert.ok(check(), 'Expected diagnostic sample');
}
test('background capture runs without browser requests, records sample/upload ages and stops durably', async t => {
  const f = collector(); t.after(() => f.diag.close()); f.diag.start();
  await delay(25); assert.equal(f.rows.length, 0);
  f.diag.setEnabled('test', true);
  await until(() => f.diag.view('test').latest);
  const sample = f.diag.view('test').latest;
  assert.equal(sample.facepunch.count, 7); assert.equal(sample.a2s.players, 17);
  assert.equal(sample.population.steamAuthenticated, 17);
  assert.equal(sample.accounts[0].telemetry.performanceSampleAgeMs, 70000);
  assert.equal(sample.accounts[0].telemetry.performanceUploadAgeMs, 10000);
  assert.ok(!JSON.stringify(sample).includes('private'));
  const captureId = sample.captureId;
  await until(() => f.rows.filter(row => row.event === 'population_sample').length >= 2);
  f.diag.setEnabled('test', false);
  const count = f.rows.length; await delay(50);
  assert.equal(f.rows.length, count); assert.equal(f.server.diagnosticsEnabled, false);
  assert.equal(f.diag.view('test').enabled, false);
  assert.equal(f.rows.at(-1).captureId, captureId);
});
test('capture avoids overlapping cycles, aborts an outstanding query and excludes late samples after stop', async t => {
  let calls = 0, finish, querySignal;
  const f = collector({ query: async (_endpoint, { signal }) => { calls++; querySignal = signal; return new Promise(resolve => { finish = resolve; }); } });
  t.after(() => f.diag.close());
  f.diag.setEnabled('test', true); await f.diag.tick(); await f.diag.tick();
  assert.equal(calls, 1);
  f.diag.setEnabled('test', false); assert.equal(querySignal.aborted, true);
  finish({ status: 'ok', players: 17 }); await until(() => !f.diag.busy);
  assert.equal(f.rows.some(row => row.event === 'population_sample'), false);
});
test('capture restores enabled settings and records missing query configuration explicitly', async t => {
  const f = collector(); t.after(() => f.diag.close());
  f.server.diagnosticsEnabled = true; f.server.queryPort = null; f.diag.start();
  await until(() => f.diag.view('test').latest);
  assert.equal(f.diag.view('test').latest.a2s.status, 'waiting_address');
  assert.equal(f.diag.view('test').latest.a2s.players, null);
});
