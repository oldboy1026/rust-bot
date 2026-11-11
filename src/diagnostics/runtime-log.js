import { AccountJournal } from '../facepunch/log.js';

export class RuntimeJournal extends AccountJournal {
  constructor({ directory, maxFileBytes = 4 * 1024 * 1024, backups = 4, now = Date.now }) {
    super({}, directory, { maxFileBytes, backups, now, version: '1.0.12' });
  }
}
