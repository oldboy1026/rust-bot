import { randomBytes, createHash, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeWorld } from './client-profile.js';

const template = JSON.parse(readFileSync(new URL('./simulated-performance.json', import.meta.url), 'utf8'));
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const ticks = ms => (BigInt(Math.trunc(ms)) * 10000n + TICKS_AT_UNIX_EPOCH).toString();
const guid = () => randomBytes(16).toString('hex');
const SCENES = ['map', 'inventory', 'mainmenu'];
const FRAME_METRICS = ['total_time', 'frames', 'frametime_average', 'frametime_99_9', 'frametime_99',
  'frametime_90', 'frametime_75', 'frametime_50', 'frametime_25', 'frametime_10', 'frametime_1', 'frametime_0_1', 'frametime_std_dev'];
function strings(value, allowed = null) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, item] of Object.entries(value).slice(0, 256)) {
    if (allowed && !allowed.includes(key)) continue;
    if (typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      result[key] = String(item).slice(0, 1024);
    }
  }
  return result;
}

export class SimulatedTelemetryData {
  constructor({ steamId, now = Date.now, session = {}, profile = {} }) {
    Object.assign(this, { steamId, now, profile, session });
    this.startedAt = session.startedAt ?? now();
    this.connectedAt = session.connectedAt ?? now();
    this.inputFrom = now();
    this.performanceFrom = now();
    this.sessionId = session.id || guid();
    this.deviceHash = createHash('sha256').update(`simulated:${this.sessionId}`).digest('hex');
  }
  envelope(data, at) { return { Timestamp: new Date(at).toISOString(), Data: data }; }
  common(type) { return { type, guid: guid(), environment: 'release', session_id: this.sessionId }; }
  serverBrowser({ endpoint, browser = {} }) {
    const options = { ...this.profile.browser, ...browser };
    const data = { ...this.common('server_browser'), filter: '', search: '', search_tags: '',
      show_full: 'true', show_empty: 'false', use_cache: 'true', prio_premium: 'true',
      prio_secure: 'false', prio_favourites: 'false' };
    Object.assign(data, strings(options, ['filter', 'search', 'search_tags']));
    for (const name of ['show_full', 'show_empty', 'use_cache', 'prio_premium', 'prio_secure', 'prio_favourites']) {
      if (options[name] !== undefined) {
        if (![true, false, 'true', 'false'].includes(options[name])) throw new Error('Invalid browser flag.');
        data[name] = String(options[name]);
      }
    }
    return this.envelope({ ...data, server_address: endpoint }, this.now());
  }
  worldMetadata({ endpoint, info = {}, world }) {
    const live = info.map_filename && Array.isArray(info.required_props)
      ? { mapFilename: info.map_filename, requiredProps: info.required_props, worldTimestamp: info.world_ts } : null;
    const configured = Object.hasOwn(this.profile.worlds || {}, endpoint) ? this.profile.worlds[endpoint] : null;
    const compatible = configured && !info.world_metadata_status
      && (!info.map_filename || configured.mapFilename === info.map_filename)
      && (!info.world_ts || !configured.worldTimestamp || String(configured.worldTimestamp) === String(info.world_ts));
    const value = world || live || (compatible ? configured : null);
    return value ? normalizeWorld(value) : null;
  }
  worldPropUsage(context) {
    const metadata = this.worldMetadata(context);
    if (!metadata) return null;
    const { endpoint } = context;
    return this.envelope({ ...this.common('world_prop_usage'), server: endpoint,
      map_filename: metadata.mapFilename, required_props: metadata.requiredProps }, this.now());
  }
  inputPacked({ baseTicks, inputs }) {
    if (typeof baseTicks !== 'string' || !/^\d{1,19}$/.test(baseTicks)
      || BigInt(baseTicks) > 3155378975999999999n || !Array.isArray(inputs) || inputs.length % 4
      || inputs.length > 65536
      || inputs.some(value => !Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
      throw new Error('Invalid packed input records.');
    }
    if (!inputs.length) return null;
    let previous = -1;
    for (let i = 0; i < inputs.length; i += 4) {
      if (inputs[i] < previous || inputs[i] < 0) throw new Error('Input offsets must be nonnegative and monotonic.');
      previous = inputs[i];
    }
    return this.envelope({ ...this.common('input_telemetry'), input_base_ticks: baseTicks,
      version: '4', inputs: [...inputs] }, this.now());
  }
  input() {
    const at = this.now();
    const elapsed = Math.max(1, Math.min(60000, at - this.inputFrom));
    const from = at - elapsed;
    this.inputFrom = at;
    const inputs = [];
    // Only the timestamp column has been decoded. Neutral zero placeholders
    // preserve the observed four-int32 layout without inventing key meanings.
    for (let offset = 0; offset < elapsed; offset += 100) inputs.push(offset * 10000, 0, 0, 0);
    return this.envelope({ ...this.common('input_telemetry'), input_base_ticks: ticks(from), version: '4', inputs }, at);
  }
  performance({ info = {}, endpoint, serverSessionId = this.session.serverSessionId,
    serverIndex = this.session.serverIndex ?? 1, performance = {}, world }) {
    const at = this.now();
    const duration = Math.max(0.001, (at - this.performanceFrom) / 1000);
    const fps = randomInt(55, 66);
    const mean = 1 / fps;
    const metadata = this.worldMetadata({ endpoint, info, world });
    const data = { ...structuredClone(template), ...this.common('client_performance'),
      time_of_day: ticks(at), connected_time: String(Math.max(0, (at - this.connectedAt) / 1000)),
      uptime: String(Math.max(0, (at - this.startedAt) / 1000)),
      server_session_id: serverSessionId, server_index: String(serverIndex), server_address: endpoint,
      world_size: String(info.world_size ?? 0), world_seed: String(info.world_seed ?? 0),
      world_ts: String(info.world_ts ?? metadata?.worldTimestamp ?? 0), map_url: String(info.map_url || ''),
      active_scene: String(info.map || 'Procedural Map'),
      is_official: String(info.is_official === true || info.is_official === 'true'),
      steam_id_hash: createHash('sha256').update(this.steamId + 'random_junk_here_489327534').digest('base64'),
      frames: String(Math.round(fps * duration)), total_time: String(duration),
      map_frames: String(Math.round(fps * duration)), map_total_time: String(duration),
      gpu_frametime_average_ms: String(randomInt(400, 801) / 100),
      ping_average: String(randomInt(35, 81)), ping_count: String(Math.max(1, Math.floor(duration / 5))),
      ram_managed: '536870912', ram_total: '4294967296',
    };
    for (const prefix of ['', 'map_']) {
      for (const [suffix, factor] of Object.entries({ average: 1, '99_9': 2, '99': 1.7, '90': 1.3,
        '75': 1.1, '50': 1, '25': 0.9, '10': 0.8, '1': 0.7, '0_1': 0.6, std_dev: 0.1 })) {
        data[`${prefix}frametime_${suffix}`] = String(mean * factor);
      }
    }
    data.hardware.device_hash = this.deviceHash;
    data.application.network_version = String(info.protocol ?? data.application.network_version);
    const sample = { ...this.profile.performance, ...performance };
    for (const [field, name] of [['hardware', 'hardware'], ['graphics_settings', 'graphicsSettings'], ['application', 'application']]) {
      Object.assign(data[field], strings(sample[name], Object.keys(data[field])));
    }
    data.hardware.device_hash = this.deviceHash;
    data.modified_convars = strings(sample.modifiedConvars);
    data.application.network_version = String(info.protocol ?? data.application.network_version);
    if (sample.scenes !== undefined) {
      if (!sample.scenes || typeof sample.scenes !== 'object' || Array.isArray(sample.scenes)) throw new Error('Invalid scene metrics.');
      // Scene groups are conditional in native samples. Empty scenes remove
      // the default map group; supplied metrics keep their string wire types.
      for (const scene of SCENES) {
        for (const name of FRAME_METRICS) delete data[`${scene}_${name}`];
        for (const [name, value] of Object.entries(strings(sample.scenes?.[scene], FRAME_METRICS))) {
          data[`${scene}_${name}`] = value;
        }
      }
    }
    if (sample.gcCount !== undefined) {
      if (!/^\d+$/.test(String(sample.gcCount)) || !Number.isSafeInteger(Number(sample.gcCount))) throw new Error('Invalid GC count.');
      data.gc_count = String(sample.gcCount);
    }
    if (sample.loadTimes !== undefined && (!this.performanceReported || performance.loadTimes !== undefined)) {
      if (!sample.loadTimes || typeof sample.loadTimes !== 'object' || Array.isArray(sample.loadTimes)
        || Object.keys(sample.loadTimes).length > 64
        || Object.values(sample.loadTimes).some(value => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error('Load times must contain nonnegative integer durations.');
      }
      data.load_times = structuredClone(sample.loadTimes);
    }
    this.performanceReported = true;
    this.performanceFrom = at;
    return this.envelope(data, at);
  }
}
