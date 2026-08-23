import { createHmac, timingSafeEqual } from 'node:crypto';

function signature(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueMediaToken(secret, meetingId, ttlMs = 5 * 60 * 1000, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ meetingId, exp: now + ttlMs })).toString('base64url');
  return `${payload}.${signature(secret, payload)}`;
}

export function verifyMediaToken(secret, token, meetingId, now = Date.now()) {
  if (!secret || typeof token !== 'string') return false;
  const [payload, supplied, extra] = token.split('.');
  if (!payload || !supplied || extra) return false;
  const expected = signature(secret, payload);
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return value.meetingId === meetingId && Number.isFinite(value.exp) && value.exp >= now;
  } catch { return false; }
}
