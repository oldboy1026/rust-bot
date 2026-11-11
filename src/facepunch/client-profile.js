import { readFileSync, statSync } from 'node:fs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function normalizeWorld(value) {
  if (!object(value)) throw new Error('Invalid world metadata.');
  const mapFilename = value.mapFilename ?? value.map_filename;
  const requiredProps = value.requiredProps ?? value.required_props;
  if (typeof mapFilename !== 'string' || !mapFilename.trim() || mapFilename.length > 512
    || /[\x00-\x1f]/.test(mapFilename) || !Array.isArray(requiredProps)
    || Buffer.byteLength(JSON.stringify(requiredProps)) > 64 * 1024) {
    throw new Error('World metadata requires a map filename and a bounded required-props array.');
  }
  const world = { mapFilename, requiredProps: structuredClone(requiredProps) };
  const timestamp = value.worldTimestamp ?? value.world_ts;
  if (timestamp !== undefined) {
    if (!/^\d{1,19}$/.test(String(timestamp))) throw new Error('Invalid world timestamp.');
    world.worldTimestamp = String(timestamp);
  }
  return world;
}
export function validateClientProfile(value) {
  if (!object(value)) throw new Error('Client profile must be an object.');
  if (value.inputMode !== undefined && !['neutral', 'none'].includes(value.inputMode)) throw new Error('Invalid input mode.');
  for (const key of ['browser', 'worlds', 'performance']) {
    if (value[key] !== undefined && !object(value[key])) throw new Error('Invalid client profile section.');
  }
  const profile = structuredClone(value);
  if (profile.worlds) {
    if (Object.keys(profile.worlds).length > 256) throw new Error('Too many world profiles.');
    for (const endpoint of Object.keys(profile.worlds)) profile.worlds[endpoint] = normalizeWorld(profile.worlds[endpoint]);
  }
  return profile;
}
export function loadClientProfile(path) {
  try {
    if (statSync(path).size > 256 * 1024) throw new Error('Client profile exceeds 256 KiB.');
    return validateClientProfile(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('无法读取 Facepunch 客户端配置，请检查 JSON 格式、世界数据及文件大小。', { cause: error });
  }
}
