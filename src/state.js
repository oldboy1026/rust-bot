import { randomUUID } from 'node:crypto';
import { EncryptedStore } from './steam/store.js';
import { ApiError, publicOrigin, requireText, secret } from './util.js';
import { randomChinaPublicIPv4 } from './network/china-ipv4.js';
import { gameSettings } from './public-player-counts.js';

export class ControllerState {
  constructor(store) {
    this.store = store;
    this.data = store.read()[0] || { version: 1, servers: [], assignments: [], commandId: 0, eventKeys: [] };
    if (this.data.version !== 1 || !Array.isArray(this.data.servers) || !Array.isArray(this.data.assignments)
      || !Array.isArray(this.data.eventKeys) || !Number.isSafeInteger(this.data.commandId)) {
      throw new Error('Invalid controller state.');
    }
    this.events = [];
    // Upgrade only legacy placeholder addresses; persist once so restart and
    // ticket renewal keep the same display address for each assignment.
    const usedIps = new Set(this.data.assignments.map(item => item.ip));
    let migrated = false;
    for (const item of this.data.assignments) {
      if (item.ip && item.ip !== '0.0.0.0') continue;
      item.ip = randomChinaPublicIPv4(usedIps);
      usedIps.add(item.ip);
      migrated = true;
    }
    if (migrated) this.save();
  }
  static open(directory) { return new ControllerState(new EncryptedStore(directory)); }
  save() { this.store.write([this.data]); }
  server(id) {
    const record = this.data.servers.find(server => server.id === id);
    if (!record) throw new ApiError(404, '找不到服务器。');
    return record;
  }
  createServer(input) {
    const server = { id: randomUUID(), name: requireText(input.name, '服务器名称', 80),
      publicUrl: publicOrigin(input.publicUrl), pairKey: secret(), ...gameSettings(input) };
    this.data.servers.push(server);
    this.save();
    return server;
  }
  pair(id) {
    const server = this.server(id);
    const url = new URL('/ws', server.publicUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return { command: `rne.pair ${server.pairKey} ${url.href}`, wsUrl: url.href };
  }
  nextCommandId() {
    if (this.data.commandId >= Number.MAX_SAFE_INTEGER - 1) throw new Error('Command sequence exhausted.');
    this.data.commandId++;
    this.save();
    return this.data.commandId;
  }
  record(event) {
    this.events.push({ time: new Date().toISOString(), ...event });
    if (this.events.length > 200) this.events.shift();
  }
}
