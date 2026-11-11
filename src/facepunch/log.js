import { appendFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const sensitiveKey = /^(?:authorization|proxy-authorization|cookie|set-cookie|steam[_-]?token|x-api-key|api[_-]?key|pair[_-]?key|password|refresh[_-]?token|machine[_-]?auth[_-]?token|(?:auth|session|webapi)?[_-]?ticket(?:[_-]?(?:hex|data))?|secret|token|.*[_-](?:token|password|secret))$/i;
export function redactLog(value, secrets = []) {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
    return text.replace(/((?:STEAM_TOKEN|X-API-KEY|Authorization|password)\s*[:=]\s*)(?:Bearer\s+)?([^\s,;"}]+)/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => redactLog(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : redactLog(item, secrets)]));
  return value;
}

// One bounded journal per account. Identity is metadata; file names are derived
// from a sanitized label and a hash, never from an unchecked account path.
export class FacepunchLogStore {
  constructor({ directory, maxFileBytes = 16 * 1024 * 1024, backups = 4, now = Date.now }) {
    this.directory = resolve(directory);
    Object.assign(this, { maxFileBytes, backups, now });
  }
  forAccount(identity) {
    const label = String(identity.accountId || 'account').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'account';
    const hash = createHash('sha256').update(String(identity.accountId)).digest('hex').slice(0, 12);
    return new AccountJournal({ ...identity }, join(this.directory, `${label}-${hash}`), this);
  }
}

export class AccountJournal {
  constructor(identity, directory, store) {
    Object.assign(this, { identity, directory, store });
    this.path = join(directory, 'events.jsonl');
    this.error = null;
  }
  rotate() {
    const { backups, maxFileBytes } = this.store;
    let size = 0;
    try { size = statSync(this.path).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (size < maxFileBytes) return;
    const last = join(this.directory, `events.${backups}.jsonl`);
    try { unlinkSync(last); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (let i = backups - 1; i >= 1; i--) {
      try { renameSync(join(this.directory, `events.${i}.jsonl`), join(this.directory, `events.${i + 1}.jsonl`)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { renameSync(this.path, join(this.directory, 'events.1.jsonl')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  write(event, details = {}, { secrets = [] } = {}) {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.rotate();
      const record = redactLog({ timestamp: new Date(this.store.now()).toISOString(), version: this.store.version || '1.0.4',
        ...this.identity, event, ...details }, secrets);
      appendFileSync(this.path, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
      this.error = null;
      return true;
    } catch (error) {
      this.error = `日志文件写入失败（${/^[A-Z0-9_]+$/.test(error.code) ? error.code : 'IO_ERROR'}），请检查目录权限和磁盘空间。`;
      return false;
    }
  }
}
