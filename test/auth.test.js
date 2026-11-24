import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { findCredential, hashPassword, sessionCookie } from '../backend/lib/auth.js';

test('session cookie is Secure behind HTTPS and remains usable for local HTTP', () => {
  const httpsCookie = sessionCookie('token', { headers: { 'x-forwarded-proto': 'https' }, socket: {} });
  assert.match(httpsCookie, /HttpOnly/);
  assert.match(httpsCookie, /SameSite=Lax/);
  assert.match(httpsCookie, /Secure/);

  const localCookie = sessionCookie('token', { headers: {}, socket: {} });
  assert.doesNotMatch(localCookie, /Secure/);
});

test('known default passwords are rejected', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(() => hashPassword('admin123'), (error) => error?.code === 'WEAK_PASSWORD');
    await assert.rejects(() => hashPassword('12345678'), (error) => error?.code === 'WEAK_PASSWORD');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('local test mode permits documented test credentials', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    assert.match(await hashPassword('admin123'), /^scrypt\$/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('backend API key authenticates with a hash-only server configuration', () => {
  const key = 'chensi_test_backend_key_1234567890';
  const user = { id: 'user_admin', role: 'admin', status: 'active', deletedAt: null };
  const previousHash = process.env.IP_AGENT_BACKEND_API_KEY_SHA256;
  const previousUserId = process.env.IP_AGENT_BACKEND_API_USER_ID;
  process.env.IP_AGENT_BACKEND_API_KEY_SHA256 = createHash('sha256').update(key).digest('hex');
  process.env.IP_AGENT_BACKEND_API_USER_ID = user.id;
  try {
    const store = { users: [user], sessions: [] };
    assert.equal(findCredential({ headers: { 'x-api-key': key } }, store)?.user, user);
    assert.equal(findCredential({ headers: { authorization: `Bearer ${key}` } }, store)?.user, user);
    assert.equal(findCredential({ headers: { 'x-api-key': `${key}-invalid` } }, store), null);
  } finally {
    if (previousHash === undefined) delete process.env.IP_AGENT_BACKEND_API_KEY_SHA256;
    else process.env.IP_AGENT_BACKEND_API_KEY_SHA256 = previousHash;
    if (previousUserId === undefined) delete process.env.IP_AGENT_BACKEND_API_USER_ID;
    else process.env.IP_AGENT_BACKEND_API_USER_ID = previousUserId;
  }
});
