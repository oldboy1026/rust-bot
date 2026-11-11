import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FacepunchTelemetry } from '../src/facepunch/telemetry.js';
import { SimulatedTelemetryData } from '../src/facepunch/simulated-data.js';
import { loadClientProfile } from '../src/facepunch/client-profile.js';

const ID = '76561198000000001';
const endpoint = '8.8.8.8:28015';
const world = { mapFilename: 'test-map-from-client.map', requiredProps: [] };
const baseContext = () => ({ endpoint, bot: { alive: true }, info: { world_seed: 42, world_size: 3500 } });
const tickets = { async withTicket(callback) {
  await callback({ ticket: Buffer.from('synthetic-test-ticket'), steamId: ID, steamAcknowledged: true });
  return { cleanupAcknowledged: true };
} };
function workerFixture(t, options = {}) {
  let clock = 1000000;
  const requests = [], states = [];
  const worker = new FacepunchTelemetry({ apiKey: 'synthetic-test-api-key', tickets, steamId: ID, now: () => clock,
    context: baseContext, profile: { worlds: { [endpoint]: world } }, onStatus: value => states.push(value),
    fetchImpl: async (_url, request) => {
      requests.push({ type: request.headers.TYPE, batch: JSON.parse(gunzipSync(request.body)) });
      return new Response(null, { status: 204 });
    }, ...options });
  t.after(() => worker.stop());
  return { worker, requests, states, advance(ms) { clock += ms; } };
}

test('browser and world contracts keep observed string flags, isolated GUIDs and shared client session', () => {
  const data = new SimulatedTelemetryData({ steamId: ID, profile: { worlds: { [endpoint]: world } } });
  const browser = data.serverBrowser({ ...baseContext(), browser: { show_full: false, filter: 'official' } });
  const props = data.worldPropUsage(baseContext());
  assert.equal(Object.keys(browser.Data).length, 14);
  assert.equal(Object.keys(props.Data).length, 7);
  assert.equal(browser.Data.show_full, 'false');
  assert.equal(browser.Data.filter, 'official');
  assert.equal(browser.Data.server_address, props.Data.server);
  assert.equal(props.Data.map_filename, world.mapFilename);
  assert.deepEqual(props.Data.required_props, []);
  assert.equal(browser.Data.session_id, props.Data.session_id);
  assert.notEqual(browser.Data.guid, props.Data.guid);
  assert.equal(data.worldPropUsage({ ...baseContext(), endpoint: '1.1.1.1:28015' }), null);
  assert.throws(() => data.serverBrowser({ ...baseContext(), browser: { show_full: 'not-a-boolean' } }));
});

test('browser sends once immediately; world and performance accumulate for the next gameplay upload', async t => {
  const f = workerFixture(t);
  await f.worker.flush();
  assert.deepEqual(f.requests.map(r => r.batch.map(e => e.Data.type)), [['server_browser']]);
  assert.equal(f.states.at(-1).tables.gameplay_events.pendingEvents, 1);
  assert.equal(f.states.at(-1).tables.gameplay_events.nextEventAt, new Date(1030000).toISOString());
  f.advance(30000); await f.worker.flush();
  assert.equal(f.states.at(-1).lastPerformanceSampleAt, new Date(1030000).toISOString());
  const initialPerformance = f.worker.pending.get('gameplay_events').batch.find(e => e.Data.type === 'client_performance').Data;
  assert.equal(initialPerformance.map_frames, undefined);
  assert.equal(initialPerformance.world_ts, '0', 'Unknown world time is not replaced with client start time');
  f.advance(30000); await f.worker.flush();
  assert.deepEqual(f.requests.map(r => r.type), ['gameplay_events', 'input_events']);
  assert.equal(f.states.at(-1).tables.gameplay_events.pendingEvents, 2);
  assert.deepEqual(f.states.at(-1).tables.gameplay_events.pendingEventTypes, ['world_prop_usage', 'client_performance']);
  f.advance(240000); await f.worker.flush();
  const gameplay = f.requests.filter(r => r.type === 'gameplay_events');
  assert.equal(gameplay.length, 2);
  assert.deepEqual(gameplay[1].batch.map(e => e.Data.type), ['world_prop_usage', 'client_performance']);
  assert.equal(f.states.at(-1).tables.gameplay_events.sentEvents, 3);
  assert.equal(f.states.at(-1).tables.gameplay_events.pendingEvents, 0);
  assert.equal(f.states.at(-1).lastPerformanceUploadedAt, new Date(1300000).toISOString());
  assert.equal(f.states.at(-1).lastUploadedPerformanceSampleAt, new Date(1030000).toISOString());
});

test('a failed gameplay upload preserves lifecycle GUIDs when new performance joins its retry', async t => {
  const attempts = [];
  const f = workerFixture(t, { fetchImpl: async (_url, request) => {
    if (request.headers.TYPE !== 'gameplay_events') return new Response(null, { status: 204 });
    attempts.push(JSON.parse(gunzipSync(request.body)));
    return new Response(null, { status: attempts.length === 1 ? 503 : 204 });
  } });
  await f.worker.flush();
  const browserGuid = attempts[0][0].Data.guid;
  f.advance(60000); await f.worker.flush();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1].map(e => e.Data.type), ['server_browser', 'world_prop_usage', 'client_performance']);
  assert.equal(attempts[1][0].Data.guid, browserGuid);
  assert.equal(f.states.at(-1).tables.gameplay_events.pendingEvents, 0);
});

test('world metadata can arrive later without repeating the browser event or guessing a map filename', async t => {
  let available = false;
  const f = workerFixture(t, { profile: {}, context: () => ({ ...baseContext(), ...(available ? { world } : {}) }) });
  await f.worker.flush();
  assert.equal(f.states.at(-1).lifecycle.worldMetadataMissing, true);
  assert.equal(f.states.at(-1).lifecycle.worldQueued, false);
  available = true;
  f.advance(60000); await f.worker.flush();
  assert.equal(f.states.at(-1).lifecycle.worldQueued, true);
  assert.equal(f.states.at(-1).lifecycle.worldMetadataMissing, false);
  assert.equal(f.requests.filter(r => r.batch.some(e => e.Data.type === 'server_browser')).length, 1);
});

test('new performance coalesces only old performance and preserves buffered world metadata', async t => {
  const f = workerFixture(t);
  await f.worker.flush();
  f.advance(60000); await f.worker.flush();
  const first = f.worker.pending.get('gameplay_events').batch;
  const worldGuid = first.find(e => e.Data.type === 'world_prop_usage').Data.guid;
  const oldPerformanceGuid = first.find(e => e.Data.type === 'client_performance').Data.guid;
  f.worker.enqueue('gameplay_events', [f.worker.data.performance(baseContext())], 1060000);
  const pending = f.worker.pending.get('gameplay_events').batch;
  assert.equal(pending.length, 2);
  assert.equal(pending[0].Data.guid, worldGuid);
  assert.notEqual(pending[1].Data.guid, oldPerformanceGuid);
});

test('queue overflow preserves the existing unsent gameplay batch', async t => {
  const f = workerFixture(t, { maxGameplayEvents: 1 });
  await f.worker.flush();
  const original = f.worker.pending.get('gameplay_events');
  assert.throws(() => f.worker.enqueue('gameplay_events', [f.worker.data.serverBrowser(baseContext())], 1000000));
  assert.equal(f.worker.pending.get('gameplay_events'), original);
  assert.equal(original.batch[0].Data.type, 'world_prop_usage');
});

test('performance supports conditional scene groups, integer load times and a connection age separate from uptime', () => {
  const data = new SimulatedTelemetryData({ steamId: ID, now: () => 100000,
    session: { id: 'a'.repeat(32), startedAt: 10000, connectedAt: 80000, serverIndex: 2, serverSessionId: 'b'.repeat(32) } });
  const perf = data.performance({ ...baseContext(), performance: { scenes: { inventory: { total_time: 3, frames: 180 } },
    modifiedConvars: { 'graphics.fov': 90 }, gcCount: 2, loadTimes: { 'Spawning World': 34 } } }).Data;
  assert.equal(perf.uptime, '90');
  assert.equal(perf.connected_time, '20');
  assert.equal(perf.server_index, '2');
  assert.equal(perf.server_session_id, 'b'.repeat(32));
  assert.equal(perf.map_frames, undefined);
  assert.equal(perf.inventory_frames, '180');
  assert.equal(perf.modified_convars['graphics.fov'], '90');
  assert.equal(perf.gc_count, '2');
  assert.deepEqual(perf.load_times, { 'Spawning World': 34 });
  assert.throws(() => data.performance({ ...baseContext(), performance: { loadTimes: { invalid: '34' } } }));
  const fromProfile = new SimulatedTelemetryData({ steamId: ID, profile: { performance: { loadTimes: { 'Spawning World': 34 } } } });
  assert.deepEqual(fromProfile.performance(baseContext()).Data.load_times, { 'Spawning World': 34 });
  assert.equal(fromProfile.performance(baseContext()).Data.load_times, undefined);
});

test('an input source sends only available records, preserving four-int32 layout without empty uploads', async t => {
  let sample = null;
  const f = workerFixture(t, { inputSource: () => sample });
  await f.worker.flush();
  f.advance(60000); await f.worker.flush();
  assert.equal(f.requests.filter(r => r.type === 'input_events').length, 0);
  sample = { baseTicks: '638000000000000000', inputs: [0, 1, -2, 3, 1000000, 4, -5, 6] };
  f.advance(60000); await f.worker.flush();
  const input = f.requests.find(r => r.type === 'input_events').batch[0].Data;
  assert.deepEqual(input.inputs, sample.inputs);
  assert.equal(input.input_base_ticks, sample.baseTicks);
  assert.equal(input.version, '4');
  assert.notEqual(input.inputs, sample.inputs);
  assert.throws(() => f.worker.data.inputPacked({ ...sample, inputs: [1, 0, 0, 0, 0, 0, 0, 0] }));
  assert.throws(() => f.worker.data.inputPacked({ ...sample, inputs: [0, 2147483648, 0, 0] }));
});

test('native world import preserves other profile settings and excludes tickets and client identifiers', t => {
  const directory = mkdtempSync(join(tmpdir(), 'controller-world-profile-'));
  t.after(() => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  const secret = 'PRIVATE_TICKET_AND_SESSION_MUST_NOT_BE_IMPORTED';
  const input = join(directory, 'client.log');
  const output = join(directory, 'facepunch-client-profile.json');
  writeFileSync(output, JSON.stringify({ browser: { show_full: false } }));
  writeFileSync(input, `STEAM_TOKEN: ${secret}\n,${JSON.stringify({ Timestamp: '2026-10-31T12:00:00Z',
    Data: { type: 'world_prop_usage', guid: secret, session_id: secret, server: endpoint,
      map_filename: world.mapFilename, required_props: [] } })}\n,${JSON.stringify({ Timestamp: '2026-10-31T12:00:30Z',
      Data: { type: 'client_performance', server_address: endpoint, world_ts: '1793095186410', session_id: secret } })}\n`);
  const original = readFileSync(input);
  const script = fileURLToPath(new URL('../scripts/facepunch-import-world.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, input], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CONTROLLER_DATA_DIR: directory } });
  assert.equal(result.status, 0, result.stderr);
  const profile = loadClientProfile(output);
  assert.deepEqual(profile.worlds[endpoint], { ...world, worldTimestamp: '1793095186410' });
  assert.equal(profile.browser.show_full, false);
  assert.ok(!readFileSync(output, 'utf8').includes(secret));
  assert.ok(!result.stdout.includes(secret));
  assert.deepEqual(readFileSync(input), original);
});
