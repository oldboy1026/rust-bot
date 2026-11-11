import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeJournal } from '../src/diagnostics/runtime-log.js';

test('runtime journal persists state and count history across restarts and removes credential fields', t => {
  const directory = mkdtempSync(join(tmpdir(), 'controller-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new RuntimeJournal({ directory, now: () => 1000 });
  assert.equal(first.write('assignment_auth_lost', { accountId: 'test', authResponse: 'AuthTicketCanceled',
    ticket_hex: 'private-ticket', sessionTicket: 'private-session', pairKey: 'private-pair',
    password: 'private-password', nested: { refreshToken: 'private-refresh' } }), true);
  const next = new RuntimeJournal({ directory, now: () => 2000 });
  assert.equal(next.write('public_player_count', { count: 1, previousCount: 5 }), true);
  const text = readFileSync(first.path, 'utf8');
  assert.equal(text.includes('private-'), false);
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.event), ['assignment_auth_lost', 'public_player_count']);
  assert.equal(rows[0].authResponse, 'AuthTicketCanceled');
  assert.equal(rows[1].version, '1.0.12');
  assert.equal(rows[1].count, 1);
});

test('runtime journal bounds rotated history and reports disk failure without throwing', t => {
  const directory = mkdtempSync(join(tmpdir(), 'controller-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = new RuntimeJournal({ directory: join(directory, 'logs'), maxFileBytes: 1, backups: 2 });
  for (let i = 0; i < 5; i++) assert.equal(log.write('state', { index: i }), true);
  assert.equal(existsSync(join(log.directory, 'events.2.jsonl')), true);
  assert.equal(existsSync(join(log.directory, 'events.3.jsonl')), false);
  const blocked = join(directory, 'file');
  writeFileSync(blocked, 'not a directory');
  const failed = new RuntimeJournal({ directory: blocked });
  assert.equal(failed.write('state'), false);
  assert.match(failed.error, /日志文件写入失败/);
});
