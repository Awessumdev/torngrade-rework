import assert from 'node:assert/strict';
import {
  assertStrongSharedSecret,
  assertSecureRequest,
  createFixedWindowRateLimiter,
  enforceRateLimitForHeaders,
  signSessionPayload,
  verifySignedSession,
} from '../src/security/request-security.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('signed sessions reject tampering and expiration', () => {
  const secret = 'test-secret';
  const token = signSessionPayload({
    sub: 'user-1',
    type: 'USER',
    csrfToken: 'csrf-1',
    expiresAt: '2026-09-14T12:00:00.000Z',
  }, secret);

  assert.equal(verifySignedSession(token, secret, new Date('2026-09-14T11:00:00.000Z')).sub, 'user-1');
  assert.throws(
    () => verifySignedSession(`${token}x`, secret, new Date('2026-09-14T11:00:00.000Z')),
    (error) => error.code === 'INVALID_SESSION_SIGNATURE',
  );
  assert.throws(
    () => verifySignedSession(token, secret, new Date('2026-09-14T12:00:00.000Z')),
    (error) => error.code === 'SESSION_EXPIRED',
  );
});

test('secure request enforces csrf and rate limits', () => {
  const secret = 'test-secret';
  const token = signSessionPayload({
    sub: 'admin-1',
    type: 'ADMIN',
    csrfToken: 'csrf-1',
    expiresAt: '2026-09-14T12:00:00.000Z',
  }, secret);
  const limiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 60_000, now: () => 1000 });

  const session = assertSecureRequest({
    sessionToken: token,
    sessionSecret: secret,
    csrfToken: 'csrf-1',
    rateLimiter: limiter,
    rateLimitKey: 'admin-1:settle',
    now: new Date('2026-09-14T11:00:00.000Z'),
  });
  assert.equal(session.type, 'ADMIN');

  assert.throws(
    () => assertSecureRequest({
      sessionToken: token,
      sessionSecret: secret,
      csrfToken: 'csrf-1',
      rateLimiter: limiter,
      rateLimitKey: 'admin-1:settle',
      now: new Date('2026-09-14T11:00:00.000Z'),
    }),
    (error) => error.code === 'RATE_LIMIT_EXCEEDED',
  );

  assert.throws(
    () => assertSecureRequest({
      sessionToken: token,
      sessionSecret: secret,
      csrfToken: 'bad',
      now: new Date('2026-09-14T11:00:00.000Z'),
    }),
    (error) => error.code === 'CSRF_TOKEN_INVALID',
  );
});

test('system secret must be configured strongly before accepting internal deposits', () => {
  assert.throws(
    () => assertStrongSharedSecret({ expected: 'short', provided: 'short' }),
    (error) => error.code === 'SYSTEM_UNAUTHENTICATED',
  );

  assert.doesNotThrow(() => assertStrongSharedSecret({
    expected: 'a'.repeat(32),
    provided: 'a'.repeat(32),
  }));
});

test('shared API helper rate limits write-heavy endpoint buckets by client IP', () => {
  const limiter = createFixedWindowRateLimiter({ limit: 30, windowMs: 60_000, now: () => 1000 });
  const request = {
    headers: new Map([['x-forwarded-for', '203.0.113.10, 10.0.0.1']]),
  };

  for (let index = 0; index < 30; index += 1) {
    enforceRateLimitForHeaders({ headers: request.headers, limiter, keyPrefix: 'test-write-bucket' });
  }

  assert.throws(
    () => enforceRateLimitForHeaders({ headers: request.headers, limiter, keyPrefix: 'test-write-bucket' }),
    (error) => error.code === 'RATE_LIMIT_EXCEEDED',
  );
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
