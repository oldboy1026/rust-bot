import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { randomChinaPublicIPv4, isChinaPublicIPv4 } from '../src/network/china-ipv4.js';
import { ControllerState } from '../src/state.js';

test('batch allocation stays inside the China snapshot and avoids local, special and duplicate addresses', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../src/network/china-ipv4.json', import.meta.url), 'utf8'));
  const number = ip => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
  const blocks = snapshot.cidrs.map(cidr => {
    const [ip, prefix] = cidr.split('/');
    return [number(ip), number(ip) + 2 ** (32 - Number(prefix)) - 1];
  });
  const used = new Set();
  for (let i = 0; i < 2048; i++) {
    const ip = randomChinaPublicIPv4(used), value = number(ip);
    assert.ok(isIPv4(ip));
    assert.ok(blocks.some(([start, end]) => value > start && value < end));
    assert.ok(isChinaPublicIPv4(ip));
    assert.ok(!used.has(ip));
    assert.ok(![0, 255].includes(value % 256));
    used.add(ip);
  }
  for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.1.1', '127.0.0.1', '169.254.1.1', '172.16.1.1',
    '192.168.1.1', '192.0.2.1', '198.18.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '255.255.255.255', '8.8.8.8', '::1', '', null]) assert.equal(isChinaPublicIPv4(ip), false, String(ip));
});

test('legacy placeholders migrate once without changing account, server or cleanup state', () => {
  let saved = [{ version: 1, servers: [], commandId: 7, eventKeys: [], assignments: [
    { id: 'one', accountId: 'account-a', serverId: 'server', steamId: '76561198000000001',
      ip: '0.0.0.0', enabled: true, needsCleanup: true },
    { id: 'two', accountId: 'account-b', serverId: 'server', enabled: false, needsCleanup: false },
    { id: 'three', accountId: 'account-c', serverId: 'server', ip: '114.114.114.114', enabled: true },
  ] }];
  let writes = 0;
  const store = { read: () => structuredClone(saved), write: next => { saved = structuredClone(next); writes++; } };
  const before = structuredClone(saved[0]);
  const first = new ControllerState(store);
  assert.equal(writes, 1);
  assert.ok(isChinaPublicIPv4(first.data.assignments[0].ip));
  assert.ok(isChinaPublicIPv4(first.data.assignments[1].ip));
  assert.equal(new Set(first.data.assignments.map(item => item.ip)).size, 3);
  for (let i = 0; i < 2; i++) assert.deepEqual({ ...first.data.assignments[i], ip: before.assignments[i].ip },
    { ...before.assignments[i], ip: before.assignments[i].ip });
  assert.equal(first.data.assignments[2].ip, before.assignments[2].ip);
  assert.equal(first.data.commandId, 7);
  assert.deepEqual(new ControllerState(store).data, first.data);
  assert.equal(writes, 1, 'restart must preserve the allocated addresses without another migration');
});
