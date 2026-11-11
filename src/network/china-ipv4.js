import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';

const snapshot = JSON.parse(readFileSync(new URL('./china-ipv4.json', import.meta.url), 'utf8'));
const toNumber = ip => ip.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
const toAddress = value => [24, 16, 8, 0].map(bits => Math.floor(value / 2 ** bits) % 256).join('.');

function parseCidr(cidr) {
  const [ip, prefixText, extra] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!isIPv4(ip) || !/^\d+$/.test(prefixText) || extra !== undefined || prefix < 0 || prefix > 32) {
    throw new Error('Invalid bundled China IPv4 range.');
  }
  const start = toNumber(ip), size = 2 ** (32 - prefix);
  if (start % size !== 0) throw new Error('Unaligned bundled China IPv4 range.');
  return { start, end: start + size - 1 };
}

// Exclude private, shared, local, documentation, benchmark, multicast and
// reserved networks even if a future upstream snapshot accidentally includes them.
const excluded = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3'].map(parseCidr);
let total = 0;
const ranges = snapshot.cidrs.map(parseCidr)
  .filter(range => range.end - range.start > 2 && !excluded.some(block => range.start <= block.end && range.end >= block.start))
  .sort((a, b) => a.start - b.start)
  .map((range, index, sorted) => {
    if (index && range.start <= sorted[index - 1].end) throw new Error('Overlapping bundled China IPv4 ranges.');
    total += range.end - range.start - 1;
    return { ...range, limit: total };
  });
if (!total) throw new Error('Bundled China IPv4 pool is empty.');

export function isChinaPublicIPv4(ip) {
  if (typeof ip !== 'string' || !isIPv4(ip)) return false;
  const value = toNumber(ip), host = value % 256;
  return host !== 0 && host !== 255 && ranges.some(range => value > range.start && value < range.end);
}

// These addresses are display metadata, not assigned interfaces or proxies.
// Weight by address count and reject addresses used by existing assignments.
export function randomChinaPublicIPv4(used = []) {
  const taken = used instanceof Set ? used : new Set(used);
  for (let attempt = 0; attempt < 1024; attempt++) {
    const offset = randomInt(total);
    let low = 0, high = ranges.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (offset < ranges[mid].limit) high = mid;
      else low = mid + 1;
    }
    const range = ranges[low];
    const value = range.start + 1 + offset - (low ? ranges[low - 1].limit : 0);
    if (value % 256 === 0 || value % 256 === 255) continue;
    const ip = toAddress(value);
    if (!taken.has(ip)) return ip;
  }
  throw new Error('Could not allocate an unused China display IPv4 address.');
}
