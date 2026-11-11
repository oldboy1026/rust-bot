import { createHash } from 'node:crypto';

export const ticketFingerprint = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 24);
const responses = new Set(['OK', 'UserNotConnectedToSteam', 'NoLicenseOrExpired', 'VACBanned', 'LoggedInElsewhere',
  'VACCheckTimedOut', 'AuthTicketCanceled', 'AuthTicketInvalidAlreadyUsed', 'AuthTicketInvalid',
  'PublisherIssuedBan', 'AuthTicketNetworkIdentityFailure']);
export function authResponse(value) {
  const name = value === 'AuthTicketAlreadyUsed' ? 'AuthTicketInvalidAlreadyUsed' : value;
  return responses.has(name) ? name : null;
}

// Plugin details are untrusted. Never forward arbitrary fields or ticket text.
export function authDiagnostic(detail) {
  if (typeof detail !== 'string' || detail.length > 2048) return null;
  let value;
  try { value = JSON.parse(detail); } catch { return null; }
  if (!value || !['begin_requested', 'begin_result', 'begin_error', 'validate_callback',
    'end_requested', 'end_returned', 'end_error'].includes(value.operation)) return null;
  const result = { operation: value.operation, response: authResponse(value.response),
    association: value.operation === 'validate_callback' ? 'current_attempt_unverified' : 'local_operation' };
  if (/^[a-f0-9-]{36}$/.test(value.attemptId)) result.attemptId = value.attemptId;
  if (/^[a-f0-9]{24}$/.test(value.ticketFingerprint)) result.ticketFingerprint = value.ticketFingerprint;
  if (typeof value.reason === 'string' && /^[a-z_]{1,64}$/.test(value.reason)) result.reason = value.reason;
  if (typeof value.accepted === 'boolean') result.accepted = value.accepted;
  if (typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt))) result.observedAt = new Date(value.observedAt).toISOString();
  return result;
}
