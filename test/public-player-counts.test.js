import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicPlayerCounts, FACEPUNCH_COUNTS_URL, gameSettings, resolveGameEndpoint } from '../src/public-player-counts.js';

const response = data => new Response(JSON.stringify(data), { headers: {
  'last-modified': 'Fri, 30 Oct 2026 02:00:00 GMT', age: '4',
} });

test('public lookup uses the game port, manual overrides, and public connection IP for NAT', () => {
  const view = { info: { server_ip: '1.2.3.4', game_port: 40176, query_port: 40177, rcon_port: 40178 }, remoteIp: '5.6.7.8' };
  assert.equal(resolveGameEndpoint({}, view), '1.2.3.4:40176');
  assert.equal(resolveGameEndpoint({ gameIp: '9.8.7.6', gamePort: 28015 }, view), '9.8.7.6:28015');
  assert.equal(resolveGameEndpoint({}, { ...view, info: { ...view.info, server_ip: '0.0.0.0' } }), '5.6.7.8:40176');
  assert.equal(resolveGameEndpoint({}, { info: { server_ip: '127.0.0.1', game_port: 40176 }, remoteIp: '::ffff:5.6.7.8' }), '5.6.7.8:40176');
  assert.equal(resolveGameEndpoint({}, { info: { query_port: 40177, rcon_port: 40178 }, remoteIp: '5.6.7.8' }), null);
  assert.equal(resolveGameEndpoint({ publicUrl: 'http://9.8.7.6:3220' }, { info: { game_port: 40176 }, remoteIp: '127.0.0.1' }), null);
  assert.deepEqual(gameSettings({ gameIp: '', gamePort: '' }), { gameIp: '', gamePort: null });
  assert.deepEqual(gameSettings({ gamePort: '40176' }, { gameIp: '1.2.3.4' }), { gameIp: '1.2.3.4', gamePort: 40176 });
  for (const input of [{ gameIp: '0.0.0.0' }, { gameIp: '192.168.1.1' }, { gamePort: 0 },
    { gamePort: 65536 }, { gamePort: true }, { gamePort: '2e4' }, { gameIp: 'https://example.com' }]) {
    assert.throws(() => gameSettings(input), { status: 400 });
  }
});

test('one upstream map distinguishes zero, absent servers, and unknown addresses with source timestamps', async () => {
  let calls = 0;
  const counts = new PublicPlayerCounts({ fetchImpl: async (url, options) => {
    calls++;
    assert.ok(url.startsWith(FACEPUNCH_COUNTS_URL + '?'));
    assert.equal(options.headers['Cache-Control'], 'no-cache');
    assert.ok(options.signal instanceof AbortSignal);
    return response({ '1.2.3.4:40176': 0, '5.6.7.8:28015': 5 });
  } });
  const result = await counts.query([{ id: 'zero', endpoint: '1.2.3.4:40176' },
    { id: 'five', endpoint: '5.6.7.8:28015' }, { id: 'absent', endpoint: '9.8.7.6:28015' }, { id: 'unknown', endpoint: null }]);
  assert.equal(calls, 1);
  assert.equal(result.intervalMs, 3000);
  assert.deepEqual(result.servers.map(x => [x.status, x.count]), [['ok', 0], ['ok', 5], ['not_listed', null], ['waiting_address', null]]);
  assert.equal(result.servers[0].sourceUpdatedAt, '2026-10-30T02:00:00.000Z');
  assert.equal(result.servers[0].cacheAge, 4);
});

test('concurrent browsers share a fetch and each new three-second slot refreshes the map', async () => {
  let clock = 100000, calls = 0, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const counts = new PublicPlayerCounts({ now: () => clock, fetchImpl: async () => {
    calls++; await waiting; return response({ '1.2.3.4:40176': calls });
  } });
  const targets = [{ id: 'server', endpoint: '1.2.3.4:40176' }];
  const first = counts.query(targets), second = counts.query(targets);
  assert.equal(calls, 1); release();
  assert.equal((await first).servers[0].count, 1);
  assert.equal((await second).servers[0].count, 1);
  assert.equal((await counts.query(targets)).servers[0].count, 1);
  assert.equal(calls, 1);
  clock += 3000;
  assert.equal((await counts.query(targets)).servers[0].count, 2);
  assert.equal(calls, 2);
});

test('upstream failures mark previous counts as stale and invalid responses never become zero', async () => {
  let clock = 100000, mode = 'ok';
  const counts = new PublicPlayerCounts({ now: () => clock, fetchImpl: async () => {
    if (mode === 'network') throw new Error('private-network-diagnostic');
    if (mode === 'http') return new Response('rate limited', { status: 429 });
    return response(mode === 'invalid' ? { '1.2.3.4:40176': '7' } : mode === 'absent' ? {} : { '1.2.3.4:40176': 7 });
  } });
  const targets = [{ id: 'server', endpoint: '1.2.3.4:40176' }];
  await counts.query(targets);
  for (mode of ['network', 'http', 'invalid']) {
    clock += 3000;
    const result = await counts.query(targets);
    assert.equal(result.servers[0].status, 'error');
    assert.equal(result.servers[0].count, null);
    assert.equal(result.servers[0].lastKnownCount, 7);
    assert.ok(!JSON.stringify(result).includes('private-network-diagnostic'));
  }
  mode = 'absent'; clock += 3000;
  const result = await counts.query(targets);
  assert.equal(result.servers[0].status, 'not_listed');
  assert.equal(result.servers[0].count, null);
});

test('unconfigured servers do not trigger upstream requests', async () => {
  const counts = new PublicPlayerCounts({ fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal((await counts.query([{ id: 'server', endpoint: null }])).servers[0].status, 'waiting_address');
  assert.equal(counts.checkedAt, null);
});

test('public count history records changes, source freshness and periodic samples without per-poll noise', async () => {
  let clock = 100000, value = 5, fail = false;
  const rows = [];
  const counts = new PublicPlayerCounts({ now: () => clock, log: (event, details) => rows.push({ event, ...details }),
    fetchImpl: async () => { if (fail) throw new Error('network'); return response({ '1.2.3.4:28015': value }); } });
  const targets = [{ id: 'server', endpoint: '1.2.3.4:28015' }];
  await counts.query(targets); await counts.query(targets);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 5);
  assert.equal(rows[0].cacheAge, 4);
  clock += 3000; value = 1; await counts.query(targets);
  assert.equal(rows.at(-1).count, 1);
  clock += 3000; await counts.query(targets);
  assert.equal(rows.length, 2);
  clock += 60000; await counts.query(targets);
  assert.equal(rows.length, 3);
  clock += 3000; fail = true; await counts.query(targets);
  assert.equal(rows.at(-1).status, 'error');
  assert.equal(rows.at(-1).count, null);
  assert.equal(rows.at(-1).lastKnownCount, 1);
  assert.ok(rows.every(row => row.event === 'public_player_count'));
});

test('a failing diagnostic writer never breaks the public count API', async () => {
  const counts = new PublicPlayerCounts({ log: () => { throw new Error('disk'); }, fetchImpl: async () => response({ '1.2.3.4:28015': 5 }) });
  assert.equal((await counts.query([{ id: 'server', endpoint: '1.2.3.4:28015' }])).servers[0].count, 5);
});

test('public query records allowlisted response headers and distinguishes failed requests from last successful data', async () => {
  let clock = 100000, status = 200;
  const counts = new PublicPlayerCounts({ now: () => clock, fetchImpl: async () => {
    clock += 75;
    return new Response(status === 200 ? '{"1.2.3.4:28015":7}' : 'failed', { status, headers: {
      'cf-ray': 'synthetic-edge', 'x-cache': 'HIT', 'set-cookie': 'private-cookie', authorization: 'private-authorization',
    } });
  } });
  const targets = [{ id: 'test', endpoint: '1.2.3.4:28015' }];
  const good = (await counts.query(targets)).servers[0];
  assert.equal(good.request.durationMs, 75); assert.equal(good.request.headers['cf-ray'], 'synthetic-edge');
  assert.equal(good.request.headers['x-cache'], 'HIT'); assert.ok(!JSON.stringify(good).includes('private'));
  clock += 3000; status = 429;
  const failed = (await counts.query(targets)).servers[0];
  assert.equal(failed.status, 'error'); assert.equal(failed.request.status, 429);
  assert.equal(failed.lastSuccessfulRequest.status, 200);
  assert.equal(failed.lastSuccessfulRequest.requestId, good.request.requestId);
  assert.notEqual(failed.request.requestId, good.request.requestId);
});
