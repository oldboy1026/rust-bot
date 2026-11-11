import { timingSafeEqual, randomBytes } from 'node:crypto';
import { ApiError } from './steam/errors.js';

export { ApiError };
export const secret = () => randomBytes(32).toString('hex');
export function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function requireText(value, label, max = 128) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new ApiError(400, `${label}格式不正确。`);
  }
  return value.trim();
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function publicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, '请填写完整的控制端地址，例如 http://192.168.1.10:3220。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ApiError(400, '控制端地址仅支持 HTTP/HTTPS 的域名或 IP 和端口，不含路径或密码。');
  }
  return url.origin;
}
export function safeError(error) {
  return error instanceof ApiError ? error.message : '操作失败，请检查连接状态后重试。';
}
