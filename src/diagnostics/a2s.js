import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';

const request = Buffer.concat([Buffer.from('ffffffff54', 'hex'), Buffer.from('Source Engine Query\0')]);
export function parseInfo(packet) {
  let at = 5;
  const need = count => { if (at + count > packet.length) throw new Error('malformed_reply'); };
  const byte = () => { need(1); return packet[at++]; };
  const string = () => {
    const end = packet.indexOf(0, at);
    if (end < 0) throw new Error('malformed_reply');
    at = end + 1;
  };
  if (packet.length < 6 || packet.readInt32LE(0) !== -1 || packet[4] !== 0x49) throw new Error('unsupported_reply');
  const protocol = byte();
  for (let i = 0; i < 4; i++) string(); // name, map, folder, game
  need(2); const appId16 = packet.readUInt16LE(at); at += 2;
  const players = byte(), maxPlayers = byte(), bots = byte();
  byte(); byte(); byte(); byte(); // server type, OS, visibility, VAC
  string(); // version; EDF/extra data is not needed for a count comparison.
  return { protocol, appId16, players, maxPlayers, bots };
}

// Numeric IP only; connected UDP filters replies to the selected query endpoint.
// Split/compressed replies are explicitly unknown rather than a false count of 0.
export async function queryA2S({ host, port }, { signal, timeoutMs = 2500, now = Date.now } = {}) {
  const started = now();
  const base = { endpoint: `${host}:${port}`, startedAt: new Date(started).toISOString() };
  const result = extra => ({ ...base, ...extra, sampledAt: new Date(now()).toISOString(), durationMs: Math.max(0, now() - started) });
  if (!isIPv4(host) || !Number.isInteger(port) || port < 1 || port > 65535) return result({ status: 'error', code: 'invalid_endpoint' });
  return new Promise(resolve => {
    const socket = createSocket('udp4');
    let finished = false, challenges = 0, packets = 0;
    const finish = value => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try { socket.close(); } catch {}
      resolve(result(value));
    };
    const abort = () => finish({ status: 'error', code: 'aborted' });
    const timer = setTimeout(() => finish({ status: 'error', code: 'timeout' }), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    const send = bytes => socket.send(bytes, error => { if (error) finish({ status: 'error', code: 'network_error' }); });
    socket.on('error', () => finish({ status: 'error', code: 'network_error' }));
    socket.on('message', packet => {
      if (++packets > 4 || packet.length > 4096 || packet.length < 5) { finish({ status: 'error', code: 'malformed_reply' }); return; }
      if (packet.readInt32LE(0) === -2) { finish({ status: 'error', code: 'split_reply_unsupported' }); return; }
      if (packet.readInt32LE(0) === -1 && packet[4] === 0x41 && packet.length === 9 && ++challenges <= 2) {
        send(Buffer.concat([request, packet.subarray(5, 9)])); return;
      }
      try { finish({ status: 'ok', ...parseInfo(packet) }); }
      catch { finish({ status: 'error', code: 'unsupported_or_malformed_reply' }); }
    });
    socket.connect(port, host, () => { if (!finished) send(request); });
  });
}
