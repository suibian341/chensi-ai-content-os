import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'ipos_session';
const SESSION_AGE_SECONDS = 7 * 24 * 60 * 60;

function tokenHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function headerValue(request, name) {
  const value = request.headers?.[name];
  return String(Array.isArray(value) ? value[0] : value || '').trim();
}

function bearerToken(request) {
  return headerValue(request, 'authorization').match(/^Bearer\s+([^\s]+)$/i)?.[1] || '';
}

function configuredApiKeyHashes() {
  return String(process.env.IP_AGENT_BACKEND_API_KEY_SHA256 || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-f0-9]{64}$/.test(value));
}

function apiKeyMatches(token) {
  if (!token || token.length > 512) return false;
  const actual = Buffer.from(tokenHash(token), 'hex');
  return configuredApiKeyHashes().some((configured) => timingSafeEqual(actual, Buffer.from(configured, 'hex')));
}

export async function hashPassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw Object.assign(new Error('密码至少需要 8 位'), { statusCode: 400 });
  const weakPasswordsAllowed = process.env.NODE_ENV !== 'production' || process.env.IP_AGENT_ALLOW_WEAK_PASSWORDS === '1';
  if (!weakPasswordsAllowed && ['admin123', '12345678', 'password', 'qwerty123'].includes(value.toLowerCase())) {
    throw Object.assign(new Error('密码过于常见，请使用不易猜测的密码'), { statusCode: 400, code: 'WEAK_PASSWORD' });
  }
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(value, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const derived = Buffer.from(await scrypt(String(password || ''), salt, 64));
  const expected = Buffer.from(hash, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function createSession(userId, request = {}) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  return {
    token,
    record: {
      id: `session_${randomBytes(10).toString('hex')}`,
      userId,
      tokenHash: tokenHash(token),
      userAgent: String(request.headers?.['user-agent'] || '').slice(0, 240),
      ip: String(request.socket?.remoteAddress || '').slice(0, 80),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_AGE_SECONDS * 1000).toISOString(),
      revokedAt: null
    }
  };
}

function secureCookie(request) {
  const forwarded = String(request?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return process.env.IP_AGENT_COOKIE_SECURE === '1' || forwarded === 'https' || Boolean(request?.socket?.encrypted);
}

export function sessionCookie(token, request) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_AGE_SECONDS}${secureCookie(request) ? '; Secure' : ''}`;
}

export function expiredSessionCookie(request) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request) ? '; Secure' : ''}`;
}

export function parseCookies(request) {
  const result = {};
  for (const pair of String(request.headers?.cookie || '').split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(pair.slice(index + 1).trim()); } catch { result[key] = ''; }
  }
  return result;
}

export function findSession(request, store) {
  const token = bearerToken(request) || parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const hash = tokenHash(token);
  const now = Date.now();
  const session = (store.sessions || []).find((item) => item.tokenHash === hash && !item.revokedAt && Date.parse(item.expiresAt) > now);
  if (!session) return null;
  const user = (store.users || []).find((item) => item.id === session.userId && item.status === 'active' && !item.deletedAt);
  return user ? { session, user } : null;
}

export function findApiKey(request, store) {
  const token = headerValue(request, 'x-api-key') || bearerToken(request);
  if (!apiKeyMatches(token)) return null;

  const configuredUserId = String(process.env.IP_AGENT_BACKEND_API_USER_ID || '').trim();
  const activeUsers = (store.users || []).filter((item) => item.status === 'active' && !item.deletedAt);
  const user = configuredUserId
    ? activeUsers.find((item) => item.id === configuredUserId)
    : activeUsers.filter((item) => item.role === 'admin').length === 1
      ? activeUsers.find((item) => item.role === 'admin')
      : null;
  return user ? { apiKey: { userId: user.id }, user, authType: 'apiKey' } : null;
}

export function findCredential(request, store) {
  if (headerValue(request, 'x-api-key')) return findApiKey(request, store);
  const session = findSession(request, store);
  return session ? { ...session, authType: 'session' } : findApiKey(request, store);
}

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

export function revokeRequestSession(request, store) {
  const current = findSession(request, store);
  if (current) current.session.revokedAt = new Date().toISOString();
  return current;
}
