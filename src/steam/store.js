import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

function dpapi(bytes, operation) {
  const command = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; `
    + `$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); `
    + `$result=[System.Security.Cryptography.ProtectedData]::${operation}(`
    + `$bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); `
    + `[Console]::Out.Write([Convert]::ToBase64String($result))`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    input: bytes.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error('Windows DPAPI failed. Start this service as the Windows user who created its data directory.');
  }
  return Buffer.from(result.stdout.trim(), 'base64');
}

export class EncryptedStore {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'accounts.enc');
    const keyPath = join(directory, process.platform === 'win32' ? 'key.dpapi' : 'key.bin');
    if (existsSync(keyPath)) {
      const saved = readFileSync(keyPath);
      this.key = process.platform === 'win32' ? dpapi(saved, 'Unprotect') : saved;
    } else {
      if (existsSync(this.file)) throw new Error('Encryption key is missing; refusing to overwrite saved accounts.');
      this.key = randomBytes(32);
      const saved = process.platform === 'win32' ? dpapi(this.key, 'Protect') : this.key;
      writeFileSync(keyPath, saved, { flag: 'wx', mode: 0o600 });
    }
    if (this.key.length !== 32) throw new Error('Invalid account encryption key.');
  }

  read() {
    if (!existsSync(this.file)) return [];
    const envelope = JSON.parse(readFileSync(this.file, 'utf8'));
    if (envelope.version !== 1) throw new Error('Unsupported account store version.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.content, 'base64')), decipher.final(),
    ]);
    const accounts = JSON.parse(plaintext.toString('utf8'));
    if (!Array.isArray(accounts)) throw new Error('Invalid account store.');
    return accounts;
  }

  write(accounts) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const content = Buffer.concat([cipher.update(JSON.stringify(accounts), 'utf8'), cipher.final()]);
    atomicWrite(this.file, JSON.stringify({
      version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      content: content.toString('base64'),
    }));
  }
}

export function loadApiKey(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'api-key.txt');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  const key = readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid data/api-key.txt.');
  return key;
}
