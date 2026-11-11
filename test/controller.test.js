import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { AccountManager } from '../src/steam/accounts.js';
import { ControllerState } from '../src/state.js';
import { PluginHub } from '../src/hub.js';
import { BindingManager } from '../src/bindings.js';
import { createControllerHttp } from '../src/http.js';
import { isChinaPublicIPv4 } from '../src/network/china-ipv4.js';
import { PublicPlayerCounts } from '../src/public-player-counts.js';
import { SimulatedTelemetryData } from '../src/facepunch/simulated-data.js';
import { PopulationDiagnostics } from '../src/diagnostics/population.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const steamId = '76561198000000001';
const steamIdentity = { getSteamID64: () => steamId };
const key = 'c'.repeat(64);
const memory = () => {
  let value = [];
  return { read: () => structuredClone(value), write: next => { value = structuredClone(next); } };
};
async function until(check, timeout = 3500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(10); }
  assert.ok(check(), 'Expected condition did not become true before timeout.');
}

function fakeSteam({ guard = false } = {}) {
  const client = new EventEmitter();
  client.steamID = steamIdentity;
  client.active = [];
  client.issued = [];
  client.canceled = 0;
  client.parsed = new WeakMap();
  client.setPersona = () => {};
  client.logOn = () => {
    const finish = () => {
      client.emit('refreshToken', 'synthetic-refresh-secret');
      client.emit('loggedOn'); client.emit('accountInfo', 'Test player');
    };
    if (guard) client.emit('steamGuard', null, code => { assert.equal(code, 'ABCDE'); finish(); }, false);
    else finish();
  };
  client.logOff = () => {};
  client.getActiveAuthSessionTickets = () => client.active;
  client.createAuthSessionTicket = async appID => {
    assert.equal(appID, 252490);
    const bytes = Buffer.from(`synthetic-session-${client.issued.length}`);
    client.issued.push(bytes);
    client.active.push({ appID, steamID: steamIdentity, validated: false, ticketCrc: 1000 + client.issued.length });
    client.parsed.set(bytes, { appID, steamID: steamIdentity, hasValidSignature: true, isValid: true,
      isExpired: false, authTicket: bytes.subarray(0, 4), signature: bytes.subarray(4, 8) });
    return { sessionTicket: bytes };
  };
  client.cancelAuthSessionTickets = async appID => {
    assert.equal(appID, 252490);
    const count = client.active.length;
    client.active = []; client.canceled += count;
    return { canceledTicketCount: count };
  };
  return client;
}

async function fixture(t, options = {}) {
  const client = fakeSteam(options);
  const accounts = new AccountManager({ store: memory(), createClient: () => client, onlinePersona: 1,
    resultNames: {}, featureOptions: { ticketLog: options.log, ticketOptions: { parseTicket: buffer => client.parsed.get(buffer) } } });
  const state = new ControllerState(memory());
  const hub = new PluginHub({ state, commandTimeout: options.commandTimeout || 1000, heartbeatMs: 10000, log: options.log });
  const bindings = new BindingManager({ state, accounts, hub, intervalMs: 100000, retryMs: 1, errorRetryMs: 1,
    authLossRetryMs: options.authLossRetryMs ?? 1,
    telemetryEnabled: options.telemetryEnabled ?? true,
    log: options.log,
    authTimeoutMs: options.authTimeoutMs || 90000,
    ...(options.createTelemetry ? { createTelemetry: options.createTelemetry } : {}),
    ...(options.createTelemetryLog ? { createTelemetryLog: options.createTelemetryLog } : {}) });
  const diagnostics = options.createDiagnostics?.({ state, accounts, hub, bindings });
  const server = createControllerHttp({ state, accounts, hub, bindings, apiKey: key, root, publicCounts: options.publicCounts, diagnostics });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, method = 'GET', input, headers = {}) => {
    const response = await fetch(`${base}/api${path}`, { method, headers: { Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json', ...headers }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const target = state.createServer({ name: 'Test Rust', publicUrl: base });
  const sockets = [];
  const connect = async (pluginOptions = {}) => {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, { headers: { Authorization: `Bearer ${target.pairKey}` } });
    sockets.push(socket);
    const plugin = { socket, bots: pluginOptions.bots || new Map(), frames: [], registers: 0, unregisters: 0, eventId: 0,
      serverInfo: pluginOptions.serverInfo,
      event(event, id = ++plugin.eventId, timestamp = Math.floor(Date.now() / 1000), detail = 'synthetic-private-detail') {
        socket.send(JSON.stringify({ id, type: 'event', name: event,
          payload: { steam_id: steamId, event, detail, timestamp } }));
      } };
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString()); plugin.frames.push(frame);
      if (frame.type !== 'cmd') return;
      let payload = { ok: true };
      if (frame.name === 'reconcile') {
        payload.bots = [...plugin.bots.values()];
        if (plugin.serverInfo) payload.server_info = plugin.serverInfo;
      }
      if (frame.name === 'register_bot') {
        plugin.registers++;
        assert.equal(frame.payload.noauth, false);
        assert.equal(frame.payload.steam_id, steamId);
        assert.ok(frame.payload.ticket_hex.length > 0);
        plugin.bots.set(steamId, { steam_id: steamId, name: frame.payload.name, alive: true, health: 100, has_steam_session: true });
        if (pluginOptions.authBeforeReply) plugin.event('steam_auth_ok');
        if (pluginOptions.dropRegisterReply) return;
      }
      if (frame.name === 'unregister_bot') {
        plugin.unregisters++;
        plugin.bots.delete(frame.payload.steam_id);
      }
      socket.send(JSON.stringify({ type: 'resp', replyTo: frame.id, payload }));
      socket.send(JSON.stringify({ type: 'ack', ackId: frame.id }));
    });
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'hello', payload: { hostname: 'Local test', protocol: 2635,
      ignored_secret: 'not-retained', server_steam_id: '90000000000000001', ...pluginOptions.info } }));
    await until(() => hub.connected(target.id));
    await until(() => plugin.frames.some(frame => frame.type === 'hello_ack'));
    return plugin;
  };
  t.after(async () => {
    diagnostics?.close();
    await bindings.close(); accounts.close(); hub.close();
    for (const socket of sockets) socket.terminate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const login = async () => {
    const response = await api('/accounts', 'POST', { accountName: 'testuser', password: 'synthetic-password' });
    assert.equal(response.status, 202);
    await until(() => accounts.get('testuser').state === (options.guard ? 'guard_required' : 'online'));
  };
  const assign = async () => {
    const result = await api('/assignments', 'POST', { accountId: 'testuser', serverId: target.id, displayName: 'Tester' });
    assert.equal(result.status, 201);
    return result.body;
  };
  return { state, hub, bindings, accounts, client, server, base, target, api, connect, login, assign };
}

test('admin API, plugin credentials and browser origin boundaries remain separate', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/state', 'GET', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.api('/state', 'GET', undefined, { Authorization: `Bearer ${f.target.pairKey}` })).status, 401);
  assert.equal((await f.api('/state', 'GET', undefined, { Origin: 'https://different.example' })).status, 403);
  const response = await fetch(`${f.base}/health`); assert.equal(response.status, 200);
  const bad = new WebSocket(`${f.base.replace('http:', 'ws:')}/ws`, { headers: { Authorization: `Bearer ${key}` } });
  bad.on('error', () => {});
  const [request] = await once(bad, 'unexpected-response');
  request.destroy(); bad.terminate();
  const result = await f.api(`/servers/${f.target.id}/pair`);
  assert.match(result.body.command, /^rne\.pair [a-f0-9]{64} ws:\/\//);
});

test('plugin metadata refresh supplies map data automatically and clears obsolete world information', async t => {
  const rows = [];
  const f = await fixture(t, { log: (event, details) => rows.push({ event, ...details }) });
  const info = { server_ip: '1.2.3.4', game_port: 28015, map_filename: 'first.map',
    required_props: ['props/a'], world_ts: '1793095186410', map_url: 'https://maps.example/first.map',
    world_metadata_status: 'ready', plugin_version: '2.5.7' };
  const plugin = await f.connect({ info });
  const data = new SimulatedTelemetryData({ steamId, profile: { worlds: { '1.2.3.4:28015': {
    mapFilename: 'obsolete.map', requiredProps: ['old'], worldTimestamp: '1' } } } });
  let current = f.hub.view(f.target.id).info;
  assert.equal(data.worldPropUsage({ endpoint: '1.2.3.4:28015', info: current }).Data.map_filename, 'first.map');
  assert.equal(data.performance({ info: current }).Data.map_url, info.map_url);
  plugin.serverInfo = { ...info, map_filename: 'second.map', required_props: [], world_ts: '1793095186411', map_url: undefined,
    level_url: 'https://maps.example/second.map' };
  await f.hub.reconcile(f.target.id);
  current = f.hub.view(f.target.id).info;
  const world = data.worldPropUsage({ endpoint: '1.2.3.4:28015', info: current });
  assert.equal(world.Data.map_filename, 'second.map');
  assert.deepEqual(world.Data.required_props, []);
  assert.equal(current.map_url, plugin.serverInfo.level_url);
  plugin.serverInfo = { ...plugin.serverInfo, required_props: null, world_metadata_status: 'unavailable' };
  await f.hub.reconcile(f.target.id);
  assert.equal(data.worldPropUsage({ endpoint: '1.2.3.4:28015', info: f.hub.view(f.target.id).info }), null);
  plugin.serverInfo = { ...info, required_props: [{ invalid: 'not a resource name' }] };
  await f.hub.reconcile(f.target.id);
  assert.equal(f.hub.view(f.target.id).info.required_props, undefined);
  assert.ok(rows.some(row => row.event === 'server_metadata_updated' && row.source === 'reconcile'));
});

test('auth-loss reasons and lease phases are recorded without command payloads or raw remote details', async t => {
  const rows = [];
  const log = (event, details) => rows.push({ event, ...details });
  const publicCounts = new PublicPlayerCounts({ log, fetchImpl: async () => new Response('{"1.2.3.4:28015":3}') });
  const f = await fixture(t, { log, publicCounts });
  const snapshot = async () => (await f.api('/state')).body;
  assert.equal((await snapshot()).servers[0].population.pluginEntities, null);
  await f.login(); const plugin = await f.connect({ info: { server_ip: '1.2.3.4', game_port: 28015 } }); await f.assign();
  await until(() => plugin.registers === 1);
  await f.hub.reconcile(f.target.id);
  const waiting = (await snapshot()).servers[0].population;
  assert.equal(waiting.pluginEntities, 1);
  assert.equal(waiting.presentAssignments, 1);
  assert.equal(waiting.steamAuthenticated, 0, 'plugin session flag does not confirm authentication');
  assert.equal((await f.api('/public-player-counts')).body.servers[0].count, 3);
  plugin.event('steam_auth_ok');
  await until(() => rows.some(row => row.event === 'assignment_state' && row.phase === 'authenticated'));
  const confirmed = await snapshot();
  assert.equal(confirmed.servers[0].population.steamAuthenticated, 1);
  assert.ok(Date.parse(confirmed.assignments[0].steamAuthenticatedAt));
  await f.api('/public-player-counts');
  assert.deepEqual(rows.filter(row => row.event === 'public_player_count')
    .map(row => [row.count, row.population.steamAuthenticated]), [[3, 0], [3, 1]]);
  plugin.event('steam_auth_lost', ++plugin.eventId, Math.floor(Date.now() / 1000), 'AuthTicketCanceled');
  await until(() => rows.some(row => row.event === 'assignment_auth_lost'));
  const lost = (await snapshot()).assignments[0];
  assert.equal(lost.steamAuthenticatedAt, null);
  assert.equal(lost.lastSessionEnd.reason, 'steam_auth_lost');
  assert.equal(lost.lastSessionEnd.authResponse, 'AuthTicketCanceled');
  assert.equal(rows.find(row => row.event === 'assignment_auth_lost').authResponse, 'AuthTicketCanceled');
  assert.ok(rows.some(row => row.event === 'plugin_command_started' && row.command === 'register_bot'));
  assert.equal(JSON.stringify(rows).includes('synthetic-private-detail'), false);
  assert.equal(JSON.stringify(rows).includes('ticket_hex'), false);
});

test('rejected WebSocket upgrades survive peer resets and leave HTTP and authenticated plugins usable', async t => {
  const f = await fixture(t);
  const port = f.server.address().port;
  for (const { path, headers } of [
    { path: '/ws', headers: [] },
    { path: '/invalid', headers: [`Authorization: Bearer ${f.target.pairKey}`] },
    { path: '/ws', headers: [`Authorization: Bearer ${f.target.pairKey}`, 'Origin: https://different.example'] },
  ]) {
    const upgraded = once(f.server, 'upgrade');
    const client = createConnection({ host: '127.0.0.1', port });
    client.on('error', () => {});
    t.after(() => client.destroy());
    await once(client, 'connect');
    const received = once(client, 'data');
    client.write([`GET ${path} HTTP/1.1`, 'Host: localhost', 'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', ...headers, '', ''].join('\r\n'));
    const [, rawSocket] = await upgraded;
    // Observe close only: an error observer here would hide the missing handler.
    const closed = new Promise(resolve => rawSocket.once('close', resolve));
    const [response] = await received;
    assert.match(response.toString(), /^HTTP\/1\.1 401 /);
    client.resetAndDestroy();
    await closed;
    assert.equal((await fetch(`${f.base}/health`)).status, 200);
    assert.equal((await f.api('/state')).status, 200);
  }
  const plugin = await f.connect();
  assert.equal((await f.hub.command(f.target.id, 'ping')).ok, true);
  plugin.socket._socket.resetAndDestroy();
  await until(() => !f.hub.connected(f.target.id));
  await f.connect();
  assert.equal((await f.hub.command(f.target.id, 'ping')).ok, true);
});

test('Facepunch worker starts after hello and role reconciliation, and stops before the game ticket is canceled', async t => {
  const workers = [];
  const journal = { path: 'synthetic-account-log' };
  let f;
  f = await fixture(t, { createTelemetryLog(identity) {
    assert.equal(identity.accountId, 'testuser');
    assert.equal(identity.steamId, steamId);
    assert.ok(identity.assignmentId);
    return journal;
  }, createTelemetry(options) {
    assert.equal(options.log, journal);
    const context = options.context();
    assert.ok(context.bot, 'A reconciled role must exist before telemetry starts');
    assert.equal(context.endpoint, '8.8.8.8:28015');
    assert.equal(context.info.map_filename, 'observed-world.map');
    assert.deepEqual(context.info.required_props, []);
    assert.match(context.serverSessionId, /^[a-f0-9]{32}$/);
    assert.equal(options.steamId, steamId);
    const worker = { options, stops: 0, async stop() {
      assert.equal(f.client.canceled, 0, 'Telemetry must finish before game-ticket cancellation');
      assert.ok(options.signal.aborted);
      worker.stops++;
    } };
    options.onStatus({ status: 'scheduled', simulated: true });
    workers.push(worker);
    return worker;
  } });
  await f.login();
  const plugin = await f.connect({ info: { server_ip: '8.8.8.8', game_port: 28015,
    map_filename: 'observed-world.map', required_props: [], world_ts: '1793095186410' } });
  const item = await f.assign();
  await until(() => plugin.registers === 1);
  assert.equal(workers.length, 0, 'A register response alone is not a role reconciliation');
  await f.bindings.sync(f.target.id);
  assert.equal(workers.length, 1);
  await f.bindings.sync(f.target.id);
  assert.equal(workers.length, 1, 'Reconciliation must not duplicate workers');
  assert.equal(f.bindings.list()[0].facepunch.status, 'scheduled');
  await f.bindings.stop(item.id);
  assert.equal(workers[0].stops, 1);
  assert.equal(f.client.canceled, 1);
});

test('authenticated public-count API follows paired game endpoints and persists manual settings', async t => {
  let calls = 0;
  const publicCounts = new PublicPlayerCounts({ fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ '1.2.3.4:40176': 5, '5.6.7.8:28015': 0 }));
  } });
  const f = await fixture(t, { publicCounts });
  await f.connect({ info: { server_ip: '1.2.3.4', game_port: 40176, query_port: 40177 } });
  assert.equal((await f.api('/public-player-counts', 'GET', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal(calls, 0);
  const first = await f.api('/public-player-counts');
  assert.equal(first.status, 200);
  assert.equal(first.body.servers[0].endpoint, '1.2.3.4:40176');
  assert.equal(first.body.servers[0].count, 5);
  assert.ok(!JSON.stringify(first.body).includes(f.target.pairKey));
  assert.equal((await f.api(`/servers/${f.target.id}`, 'PATCH', { gameIp: '5.6.7.8', gamePort: 28015 })).status, 200);
  const second = await f.api('/public-player-counts');
  assert.equal(second.body.servers[0].endpoint, '5.6.7.8:28015');
  assert.equal(second.body.servers[0].count, 0);
  assert.equal(new ControllerState(f.state.store).server(f.target.id).gameIp, '5.6.7.8');
  assert.equal((await f.api(`/servers/${f.target.id}`, 'PATCH', { gamePort: 65536 })).status, 400);
  assert.equal(f.state.server(f.target.id).gamePort, 28015);
});

test('Steam Guard can complete login without storing a password', async t => {
  const f = await fixture(t, { guard: true });
  await f.login();
  assert.equal((await f.api('/accounts/testuser/guard', 'POST', { code: 'ABCDE' })).status, 202);
  assert.equal(f.accounts.get('testuser').state, 'online');
  assert.equal(f.accounts.store.read()[0].password, undefined);
  assert.equal(f.accounts.store.read()[0].refreshToken, 'synthetic-refresh-secret');
  const exported = JSON.stringify((await f.api('/state')).body);
  assert.ok(!exported.includes('synthetic-refresh-secret'));
});

test('transient Steam login failures retry with memory-only credentials; invalid credentials do not loop', async t => {
  const store = memory(), attempts = [];
  let retryDelay = 15;
  const manager = new AccountManager({ store, onlinePersona: 1, resultNames: { 20: 'ServiceUnavailable', 5: 'InvalidPassword' },
    retryDelay: () => retryDelay, createClient: () => {
      const client = new EventEmitter();
      client.setPersona = () => {};
      client.logOff = () => {};
      client.steamID = steamIdentity;
      client.logOn = details => {
        attempts.push(details);
        if (details.accountName === 'wrong') client.emit('error', { eresult: 5 });
        else if (attempts.length === 1 || details.accountName === 'cancel') client.emit('error', { eresult: 20 });
        else { client.emit('refreshToken', 'synthetic-token'); client.emit('loggedOn'); }
      };
      return client;
    } });
  t.after(() => manager.close());
  manager.login('testuser', { accountName: 'testuser', password: 'synthetic-password', twoFactorCode: 'ABCDE' });
  await until(() => manager.get('testuser').state === 'online');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].password, 'synthetic-password');
  assert.equal(attempts[1].twoFactorCode, undefined);
  assert.equal(manager.get('testuser').retryPassword, null);
  assert.ok(!JSON.stringify(store.read()).includes('synthetic-password'));
  manager.login('wrong', { accountName: 'wrong', password: 'synthetic-wrong' });
  await until(() => manager.get('wrong').state === 'error');
  assert.equal(manager.list().find(account => account.id === 'wrong').retryAt, null);
  assert.equal(manager.get('wrong').retryPassword, null);
  retryDelay = 100;
  manager.login('cancel', { accountName: 'cancel', password: 'synthetic-cancel' });
  await until(() => manager.get('cancel').state === 'retry_wait');
  await manager.logout('cancel');
  await delay(120);
  assert.equal(attempts.filter(item => item.accountName === 'cancel').length, 1);
  assert.equal(manager.get('cancel').state, 'offline');
  assert.equal(manager.get('cancel').retryPassword, null);
});

test('bulk logout stops active assignments without deleting them and reports per-account failures', async t => {
  const f = await fixture(t); await f.login();
  const plugin = await f.connect(); const item = await f.assign();
  await until(() => plugin.registers === 1);
  const response = await f.api('/accounts/batch-logout', 'POST', { ids: ['testuser', 'testuser', 'missing'] });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.results.map(({ id, ok }) => [id, ok]), [['testuser', true], ['missing', false]]);
  assert.equal(plugin.bots.size, 0);
  assert.equal(f.client.canceled, 1);
  assert.equal(f.accounts.get('testuser').state, 'offline');
  assert.equal(f.accounts.get('testuser').saved.autoConnect, false);
  assert.equal(f.bindings.assignment(item.id).enabled, false);
});

test('server bulk deletion persists offline cleanup and removes the assignment automatically on reconnect', async t => {
  const f = await fixture(t); await f.login();
  const plugin = await f.connect(); const item = await f.assign();
  await until(() => plugin.registers === 1);
  plugin.socket.close();
  await until(() => !f.hub.connected(f.target.id));
  const response = await f.api(`/servers/${f.target.id}/assignments`, 'DELETE', {});
  assert.equal(response.status, 202);
  assert.deepEqual(response.body, { deleted: 0, pending: 1 });
  const saved = new ControllerState(f.state.store).data.assignments[0];
  assert.equal(saved.deletePending, true);
  assert.equal(saved.enabled, false);
  assert.equal(f.client.canceled, 1);
  assert.equal((await f.api(`/assignments/${item.id}/start`, 'POST', {})).status, 409);
  const reconnected = await f.connect({ bots: plugin.bots });
  await until(() => f.state.data.assignments.length === 0);
  assert.equal(reconnected.unregisters, 1);
  assert.equal(reconnected.registers, 0);
  assert.equal(f.accounts.get('testuser').state, 'online');
  assert.equal(f.state.server(f.target.id).id, f.target.id);
});

test('server stop affects only its own sessions, preserves login and records, and permits restart', async t => {
  const f = await fixture(t); await f.login();
  const plugin = await f.connect(); const item = await f.assign();
  await until(() => plugin.registers === 1);
  const other = f.state.createServer({ name: 'Other server', publicUrl: f.base });
  const empty = await f.api(`/servers/${other.id}/stop`, 'POST', {});
  assert.deepEqual(empty.body, { stopped: 0, pending: 0 });
  assert.equal(plugin.bots.size, 1);
  assert.equal(f.client.canceled, 0);
  const stopped = await f.api(`/servers/${f.target.id}/stop`, 'POST', {});
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.body, { stopped: 1, pending: 0 });
  assert.equal(plugin.bots.size, 0);
  assert.equal(f.client.canceled, 1);
  assert.equal(f.accounts.get('testuser').state, 'online');
  assert.equal(f.accounts.get('testuser').saved.autoConnect, true);
  assert.equal(f.bindings.assignment(item.id).enabled, false);
  assert.equal(new ControllerState(f.state.store).data.assignments[0].enabled, false);
  assert.equal(f.bindings.list()[0].lastSessionEnd.reason, 'server_stopped');
  assert.deepEqual((await f.api(`/servers/${f.target.id}/stop`, 'POST', {})).body, { stopped: 0, pending: 0 });
  assert.equal(f.client.canceled, 1);
  assert.equal((await f.api(`/assignments/${item.id}/start`, 'POST', {})).status, 202);
  await until(() => plugin.registers === 2);
  assert.equal(f.bindings.assignment(item.id).enabled, true);
});

test('server stop retains pending cleanup while offline and removes the remote entity on reconnect', async t => {
  const f = await fixture(t); await f.login();
  const plugin = await f.connect(); const item = await f.assign();
  await until(() => plugin.registers === 1);
  plugin.socket.close();
  await until(() => !f.hub.connected(f.target.id));
  const stopped = await f.api(`/servers/${f.target.id}/stop`, 'POST', {});
  assert.equal(stopped.status, 202);
  assert.deepEqual(stopped.body, { stopped: 1, pending: 1 });
  const saved = new ControllerState(f.state.store).data.assignments[0];
  assert.equal(saved.enabled, false);
  assert.equal(saved.needsCleanup, true);
  assert.ok(!saved.deletePending);
  assert.equal(f.client.canceled, 1);
  const reconnected = await f.connect({ bots: plugin.bots });
  await until(() => !f.bindings.assignment(item.id).needsCleanup);
  assert.equal(reconnected.unregisters, 1);
  assert.equal(reconnected.registers, 0);
  assert.equal(f.state.data.assignments.length, 1);
  assert.equal(f.bindings.assignment(item.id).enabled, false);
  assert.equal(f.accounts.get('testuser').state, 'online');
});

test('a live ticket reaches register_bot, remains active, and ends after entity cleanup', async t => {
  const f = await fixture(t); await f.login(); const plugin = await f.connect(); const item = await f.assign();
  await until(() => plugin.registers === 1 && f.bindings.list()[0].phase === 'waiting_auth');
  assert.equal(f.client.canceled, 0);
  assert.equal(f.bindings.list()[0].steamAuthenticated, false, 'reported has_steam_session is not final proof');
  const frame = plugin.frames.find(frame => frame.name === 'register_bot');
  assert.ok(isChinaPublicIPv4(item.ip));
  assert.equal(frame.payload.ip, item.ip);
  assert.equal(frame.payload.ticket_hex, f.client.issued[0].toString('hex'));
  plugin.event('steam_auth_ok'); await until(() => f.bindings.list()[0].steamAuthenticated);
  const exported = JSON.stringify((await f.api('/state')).body);
  for (const material of [frame.payload.ticket_hex, f.target.pairKey, 'synthetic-private-detail', 'not-retained']) {
    assert.ok(!exported.includes(material));
  }
  assert.equal((await f.api(`/assignments/${item.id}/stop`, 'POST', {})).status, 200);
  assert.equal(plugin.bots.size, 0); assert.equal(plugin.unregisters, 1);
  assert.equal(f.client.canceled, 1); assert.ok(f.client.issued[0].every(byte => byte === 0));
  assert.equal(f.bindings.list()[0].phase, 'stopped');
});

test('assignment API generates and persists China addresses even when an old client supplies an IP', async t => {
  const f = await fixture(t); await f.login();
  const result = await f.api('/assignments', 'POST', {
    accountId: 'testuser', serverId: f.target.id, ip: '0.0.0.0',
  });
  assert.equal(result.status, 201);
  assert.ok(isChinaPublicIPv4(result.body.ip));
  const restored = new ControllerState(f.state.store);
  assert.equal(restored.data.assignments[0].ip, result.body.ip);
  f.bindings.start(result.body.id);
  assert.equal(f.bindings.assignment(result.body.id).ip, result.body.ip);
});

test('authentication arriving before command response is preserved and duplicate events are acked once', async t => {
  const f = await fixture(t); await f.login(); const plugin = await f.connect({ authBeforeReply: true }); await f.assign();
  await until(() => f.bindings.list()[0]?.phase === 'authenticated');
  const before = f.state.events.length;
  plugin.event('steam_auth_ok', 500, 2000000000); plugin.event('steam_auth_ok', 500, 2000000000);
  await until(() => plugin.frames.filter(frame => frame.type === 'ack' && frame.ackId === 500).length === 2);
  assert.equal(f.state.events.length, before + 1);
});

test('a lost register response is reconciled without duplicate register or premature ticket cancellation', async t => {
  const f = await fixture(t, { commandTimeout: 60 }); await f.login();
  const plugin = await f.connect({ dropRegisterReply: true }); await f.assign();
  await until(() => f.bindings.list()[0]?.phase === 'uncertain');
  await f.bindings.sync(f.target.id);
  assert.equal(plugin.registers, 1); assert.equal(f.client.canceled, 0);
  assert.equal(f.bindings.list()[0].phase, 'waiting_auth');
});

test('offline stop cancels the local ticket and records cleanup until plugin reconnection', async t => {
  const f = await fixture(t); await f.login(); const plugin = await f.connect(); const item = await f.assign();
  await until(() => f.bindings.list()[0]?.phase === 'waiting_auth');
  plugin.socket.terminate(); await until(() => !f.hub.connected(f.target.id));
  await f.bindings.stop(item.id);
  assert.equal(f.client.canceled, 1); assert.equal(item.needsCleanup, false); // API returns a separate JSON snapshot
  assert.equal(f.bindings.assignment(item.id).needsCleanup, true);
  const next = await f.connect({ bots: plugin.bots });
  await until(() => next.bots.size === 0 && f.bindings.list()[0].phase === 'stopped');
  await f.bindings.remove(item.id); assert.equal(f.bindings.list().length, 0);
});

test('failed final auth renews using a fresh ticket after teardown', async t => {
  const f = await fixture(t); await f.login(); const plugin = await f.connect(); await f.assign();
  await until(() => f.bindings.list()[0]?.phase === 'waiting_auth');
  plugin.event('steam_auth_lost'); await until(() => f.client.canceled === 1);
  await delay(5); await f.bindings.sync(f.target.id);
  await until(() => plugin.registers === 2);
  assert.equal(plugin.unregisters, 1); assert.equal(f.client.issued.length, 2);
  const registrations = plugin.frames.filter(frame => frame.name === 'register_bot');
  assert.ok(isChinaPublicIPv4(registrations[0].payload.ip));
  assert.equal(registrations[1].payload.ip, registrations[0].payload.ip);
  assert.ok(f.client.issued[0].every(byte => byte === 0));
});

test('missed final auth callback is bounded, and an account cannot be assigned twice', async t => {
  const f = await fixture(t, { authTimeoutMs: 30 }); await f.login(); const plugin = await f.connect(); await f.assign();
  await until(() => f.bindings.list()[0]?.phase === 'waiting_auth');
  assert.equal((await f.api('/assignments', 'POST', { accountId: 'testuser', serverId: f.target.id })).status, 409);
  await delay(40); await f.bindings.sync(f.target.id);
  await until(() => f.client.canceled === 1);
  assert.equal(plugin.bots.size, 0);
});

test('unknown remote bots are preserved while known orphan identities are cleaned before issuance', async t => {
  const f = await fixture(t); await f.login();
  const item = f.bindings.create({ accountId: 'testuser', serverId: f.target.id });
  item.steamId = steamId; item.needsCleanup = true; f.state.save();
  const bots = new Map([
    [steamId, { steam_id: steamId, alive: true, name: 'Old managed bot' }],
    ['76561198000000999', { steam_id: '76561198000000999', alive: true, name: 'Unmanaged' }],
  ]);
  const plugin = await f.connect({ bots });
  await until(() => plugin.registers === 1);
  assert.equal(plugin.unregisters, 1); assert.equal(plugin.bots.size, 2);
  assert.ok(plugin.bots.has('76561198000000999'));
});

test('update endpoints serve only the fixed plugin hash and keep download opt-in', async t => {
  const f = await fixture(t);
  const auth = { Authorization: `Bearer ${f.target.pairKey}` };
  const hash = await fetch(`${f.base}/api/plugin/hash?name=AdminLogger.cs`, { headers: auth });
  assert.equal(hash.status, 200); assert.match((await hash.json()).hash, /^[a-f0-9]{64}$/);
  assert.equal((await fetch(`${f.base}/api/plugin/hash?name=../data/api-key.txt`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${f.base}/api/plugin/download?name=AdminLogger.cs`, { headers: auth })).status, 403);
  assert.equal((await fetch(`${f.base}/api/plugin/hash?name=AdminLogger.cs`)).status, 401);
});

test('transport reconnect preserves entity and telemetry session; game reconnect changes only connection identity', async t => {
  const sessions = [];
  const f = await fixture(t, { createTelemetry(options) {
    sessions.push(structuredClone(options.session));
    return { async stop() {} };
  } });
  await f.login(); const plugin = await f.connect(); const item = await f.assign();
  await until(() => f.bindings.list()[0]?.phase === 'waiting_auth');
  await f.bindings.sync(f.target.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].serverIndex, 1);
  plugin.socket.terminate(); await until(() => !f.hub.connected(f.target.id));
  const reconnected = await f.connect({ bots: plugin.bots });
  await f.bindings.sync(f.target.id);
  assert.equal(reconnected.registers, 0); assert.equal(f.client.issued.length, 1);
  assert.equal(sessions.length, 1, 'A WebSocket reconnect does not recreate the simulated game connection');
  reconnected.bots.clear(); await f.bindings.sync(f.target.id);
  assert.equal(reconnected.registers, 1); assert.equal(f.client.issued.length, 1);
  await f.bindings.sync(f.target.id);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].id, sessions[0].id);
  assert.equal(sessions[1].startedAt, sessions[0].startedAt);
  assert.equal(sessions[1].serverIndex, 2);
  assert.notEqual(sessions[1].serverSessionId, sessions[0].serverSessionId);
  await f.bindings.stop(item.id);
  f.bindings.start(item.id);
  await until(() => reconnected.registers === 2);
  await f.bindings.sync(f.target.id);
  assert.equal(sessions.length, 3);
  assert.notEqual(sessions[2].id, sessions[1].id);
  assert.equal(sessions[2].serverIndex, 1);
});

test('a stop during delayed ticket issuance cancels the late ticket without registering it', async t => {
  const f = await fixture(t); await f.login(); const plugin = await f.connect();
  const original = f.client.createAuthSessionTicket;
  let unblock;
  const wait = new Promise(resolve => { unblock = resolve; });
  f.client.createAuthSessionTicket = async appId => { await wait; return original(appId); };
  const item = await f.assign();
  await until(() => f.bindings.list()[0]?.phase === 'issuing_ticket');
  const stop = f.bindings.stop(item.id);
  unblock(); await stop;
  assert.equal(plugin.registers, 0); assert.equal(f.client.canceled, 1);
  assert.ok(f.client.issued[0].every(byte => byte === 0));
});


test('registration attempts correlate with fingerprints and local cancellation without trusting callback attribution', async t => {
  const rows = [];
  const f = await fixture(t, { log: (event, details) => rows.push({ event, ...details }) });
  await f.login(); const plugin = await f.connect(); const assignment = await f.assign();
  await until(() => plugin.registers === 1);
  const first = plugin.frames.find(frame => frame.name === 'register_bot').payload.auth_attempt_id;
  assert.match(first, /^[a-f0-9-]{36}$/);
  const fingerprint = f.bindings.list()[0].ticketFingerprint;
  assert.match(fingerprint, /^[a-f0-9]{24}$/);
  f.client.emit('authTicketStatus', { appID: 252490, steamID: steamIdentity,
    ticketCrc: 1001, state: 2, authSessionResponse: 0, ticketGcToken: 'private-gc-token' });
  const notification = rows.find(row => row.event === 'steam_ticket_status');
  assert.equal(notification.ticketKind, 'game');
  assert.equal(notification.ticketFingerprint, fingerprint);
  assert.equal(notification.authResponse, 'OK');
  assert.equal(notification.association, 'library_crc_match');
  plugin.bots.clear(); await f.bindings.sync(f.target.id);
  assert.equal(plugin.registers, 2);
  const second = plugin.frames.filter(frame => frame.name === 'register_bot').at(-1).payload.auth_attempt_id;
  assert.notEqual(first, second);
  assert.equal(f.bindings.list()[0].ticketFingerprint, fingerprint);
  plugin.event('auth_diagnostic', ++plugin.eventId, Math.floor(Date.now()/1000), JSON.stringify({
    operation:'validate_callback', response:'AuthTicketAlreadyUsed', attemptId:second,
    ticketFingerprint:fingerprint, ticket_hex:'private-ticket-content', association:'exact_ticket' }));
  await until(() => rows.some(row => row.event === 'plugin_auth_diagnostic'));
  const diagnostic = rows.find(row => row.event === 'plugin_auth_diagnostic');
  assert.equal(diagnostic.response, 'AuthTicketInvalidAlreadyUsed');
  assert.equal(diagnostic.association, 'current_attempt_unverified');
  plugin.event('steam_auth_lost', ++plugin.eventId, Math.floor(Date.now()/1000), 'AuthTicketAlreadyUsed');
  await until(() => f.client.canceled === 1);
  const canceled = rows.find(row => row.event === 'ticket_operation' && row.operation === 'cancel_returned');
  assert.equal(canceled.ticketKind, 'game');
  assert.equal(canceled.reason, 'steam_auth_lost');
  assert.equal(canceled.attemptId, second);
  assert.equal(canceled.ticketFingerprint, fingerprint);
  assert.equal(canceled.confirmationScope, 'library_result_and_local_list');
  assert.equal(f.bindings.list()[0].lastSessionEnd.authResponse, 'AuthTicketInvalidAlreadyUsed');
  assert.ok(!JSON.stringify(rows).includes('private-ticket-content'));
  assert.ok(!JSON.stringify(rows).includes('private-gc-token'));
  assert.ok(!JSON.stringify(rows).includes('synthetic-session-'));
});

test('diagnostic control API persists its switch and validates query port overrides', async t => {
  const f = await fixture(t, { createDiagnostics: deps => new PopulationDiagnostics({ ...deps,
    publicCounts: new PublicPlayerCounts({ fetchImpl: async () => new Response('{}') }),
    query: async () => ({ status: 'ok', players: 0 }), journal: { write() {} } }) });
  assert.equal((await f.api('/servers/'+f.target.id+'/diagnostics','POST',{enabled:true})).status,200);
  assert.equal((await f.api('/state')).body.servers[0].diagnostics.enabled,true);
  assert.equal(f.state.server(f.target.id).diagnosticsEnabled,true);
  assert.equal((await f.api('/servers/'+f.target.id,'PATCH',{queryPort:28016})).status,200);
  assert.equal((await f.api('/state')).body.servers[0].queryPort,28016);
  assert.equal((await f.api('/servers/'+f.target.id,'PATCH',{queryPort:true})).status,400);
  assert.equal((await f.api('/servers/'+f.target.id+'/diagnostics','POST',{enabled:'yes'})).status,400);
  assert.equal((await f.api('/servers/'+f.target.id+'/diagnostics','POST',{enabled:false})).body.enabled,false);
});


test('matched Steam invalidation makes cleanup idempotent; unrelated or unexplained absence remains an error', async t => {
  for (const matched of [true, false]) {
    const rows = [];
    const f = await fixture(t, { log: (event, details) => rows.push({ event, ...details }) });
    await f.login(); const plugin = await f.connect(); const item = await f.assign();
    await until(() => plugin.registers === 1);
    f.client.active = [];
    f.client.emit('authTicketStatus', { appID: 252490, steamID: steamIdentity,
      ticketCrc: matched ? 1001 : 9999, state: 4, authSessionResponse: 6 });
    await f.bindings.stop(item.id);
    assert.equal(f.client.canceled, 0, 'No extra cancellation API call when the list is empty');
    const result = rows.find(row => row.event === 'ticket_operation' && row.operation === (matched ? 'cancel_returned' : 'cancel_failed'));
    assert.ok(result);
    if (matched) {
      assert.equal(result.status, 'already_invalidated');
      assert.equal(result.cancelApiCalled, false);
      assert.equal(result.confirmationScope, 'steam_status_and_local_absence');
    }
  }
});

test('auth-loss cooldown keeps late failure notifications out of a new lease and retries after the delay', async t => {
  const rows = [];
  const f = await fixture(t, { authLossRetryMs: 200, log: (event, details) => rows.push({ event, ...details }) });
  await f.login(); const plugin = await f.connect(); await f.assign();
  await until(() => plugin.registers === 1);
  plugin.event('steam_auth_lost', ++plugin.eventId, Math.floor(Date.now()/1000), 'AuthTicketCanceled');
  await until(() => rows.some(row => row.event === 'assignment_retry_scheduled'));
  assert.equal(f.bindings.runs.size, 0);
  const retry = rows.find(row => row.event === 'assignment_retry_scheduled');
  assert.equal(retry.delayMs, 200);
  assert.ok(f.bindings.list()[0].retryAt);
  plugin.event('steam_auth_lost', ++plugin.eventId, Math.floor(Date.now()/1000), 'AuthTicketCanceled');
  await f.bindings.sync(f.target.id);
  assert.equal(plugin.registers, 1);
  assert.equal(rows.filter(row => row.event === 'assignment_auth_lost').length, 1);
  await delay(210); await f.bindings.sync(f.target.id);
  await until(() => plugin.registers === 2);
  assert.equal(f.client.issued.length, 2);
});


test('auth-only diagnostic mode preserves game authentication and cleanup without starting telemetry', async t => {
  let telemetryStarts = 0;
  const f = await fixture(t, { telemetryEnabled: false, createTelemetry: () => { telemetryStarts++; throw new Error('must remain disabled'); } });
  await f.login();
  const plugin = await f.connect({ info: { server_ip: '1.2.3.4', game_port: 28015 } });
  const item = await f.assign();
  await until(() => plugin.registers === 1);
  plugin.event('steam_auth_ok');
  await until(() => f.bindings.isAuthenticated(item.id));
  await f.bindings.sync(f.target.id);
  assert.equal(telemetryStarts, 0);
  assert.equal(f.bindings.list()[0].facepunch.status, 'disabled_for_diagnostic');
  assert.equal(f.bindings.list()[0].ticketActive, true);
  assert.equal(f.client.canceled, 0);
  await f.bindings.stop(item.id);
  assert.equal(f.client.canceled, 1);
});
