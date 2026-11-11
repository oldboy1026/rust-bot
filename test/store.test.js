import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore } from '../src/steam/store.js';

test('saved login material is encrypted and can be restored by the local store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'adminlogger-store-test-'));
  try {
    const store = new EncryptedStore(directory);
    store.write([{ id: 'synthetic', refreshToken: 'synthetic-private-refresh-material' }]);
    assert.ok(!readFileSync(store.file, 'utf8').includes('synthetic-private-refresh-material'));
    assert.equal(new EncryptedStore(directory).read()[0].refreshToken, 'synthetic-private-refresh-material');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
