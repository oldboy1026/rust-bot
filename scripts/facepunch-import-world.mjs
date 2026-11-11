import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIPv4 } from 'node:net';
import { randomUUID } from 'node:crypto';
import { snapshotLines } from '../src/diagnostics/log-audit.js';
import { nativeObjects } from '../src/facepunch/native-events.js';
import { loadClientProfile, normalizeWorld } from '../src/facepunch/client-profile.js';

try {
  if (process.argv.length !== 3) throw new Error('Usage');
  const input = resolve(process.argv[2]);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const data = resolve(process.env.CONTROLLER_DATA_DIR || join(root, 'data'));
  const output = join(data, 'facepunch-client-profile.json');
  if (input.toLowerCase() === output.toLowerCase()) throw new Error('Input must be a native log.');
  const profile = loadClientProfile(output);
  profile.worlds ||= {};
  const updated = new Set();
  let imported = 0, malformed = 0;
  for await (const line of snapshotLines(input)) {
    if (line.oversized) { malformed++; continue; }
    let items;
    try { items = nativeObjects(line.text); } catch { malformed++; continue; }
    for (const { event } of items) {
      const body = event?.Data;
      if (body?.type === 'client_performance' && updated.has(body.server_address)
        && /^\d{1,19}$/.test(String(body.world_ts))) {
        profile.worlds[body.server_address].worldTimestamp = String(body.world_ts);
      }
      if (body?.type !== 'world_prop_usage' || typeof body.server !== 'string') continue;
      const match = body.server.match(/^([\d.]+):(\d+)$/);
      if (!match || !isIPv4(match[1]) || Number(match[2]) < 1 || Number(match[2]) > 65535) { malformed++; continue; }
      try {
        const endpoint = `${match[1]}:${Number(match[2])}`;
        profile.worlds[endpoint] = normalizeWorld(body);
        updated.add(endpoint);
        imported++;
      }
      catch { malformed++; }
    }
  }
  if (!imported) throw new Error('No usable world metadata found.');
  const json = JSON.stringify(profile, null, 2) + '\n';
  if (Buffer.byteLength(json) > 256 * 1024 || Object.keys(profile.worlds).length > 256) throw new Error('Profile limit reached.');
  await mkdir(data, { recursive: true });
  const temporary = output + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, json, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, output);
  } finally { await unlink(temporary).catch(() => {}); }
  console.log(`已导入 ${imported} 条世界资源记录；忽略的无效或不完整片段 ${malformed} 条。`);
  console.log(`配置：${output}`);
  console.log('只保存服务器地址、地图文件名、资源数组及已观测的世界时间戳；不会保存或重放账号和票据。重启控制端后生效。');
} catch {
  console.error('导入未完成。用法：node scripts/facepunch-import-world.mjs <原生客户端日志路径>。请确认日志含 world_prop_usage、配置可写且格式正确。');
  process.exitCode = 1;
}
