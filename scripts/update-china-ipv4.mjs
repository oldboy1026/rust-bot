import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';

const source = 'https://raw.githubusercontent.com/gaoyifan/china-operator-ip/ip-lists/china.txt';
const licenseSource = 'https://raw.githubusercontent.com/gaoyifan/china-operator-ip/master/LICENSE';
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`IP data download failed: HTTP ${response.status}`);
  return response.text();
}
const [text, license] = await Promise.all([download(source), download(licenseSource)]);
const cidrs = text.trim().split(/\r?\n/);
if (cidrs.length < 1000 || !license.startsWith('MIT License') || cidrs.some(cidr => {
  const [ip, prefix] = cidr.split('/');
  return !isIPv4(ip) || !/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > 32;
})) throw new Error('Unexpected upstream China IPv4 dataset or license.');
const snapshot = { source, downloadedAt: new Date().toISOString(),
  description: 'Mainland China prefixes from china-operator-ip; display metadata only, not proof of address ownership or reachability.',
  upstreamSha256: createHash('sha256').update(text).digest('hex'), license: 'MIT', cidrs };
writeFileSync(new URL('../src/network/china-ipv4.json', import.meta.url), JSON.stringify(snapshot, null, 2) + '\n');
writeFileSync(new URL('../docs/china-operator-ip-LICENSE.txt', import.meta.url), license);
console.log(`Updated bundled China IPv4 dataset: ${cidrs.length} CIDR ranges.`);
