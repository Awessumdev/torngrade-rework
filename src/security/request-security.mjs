import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class RequestSecurityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RequestSecurityError';
    this.code = code;
  }
}

export function signSessionPayload(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifySignedSession(token, secret, now = new Date()) {
  const [body, signature] = String(token ?? '').split('.');
  if (!body || !signature) {
    throw new RequestSecurityError('INVALID_SESSION', 'Session token is malformed.');
  }

  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new RequestSecurityError('INVALID_SESSION_SIGNATURE', 'Session signature is invalid.');
  }

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload.sub || !payload.type || !payload.expiresAt) {
    throw new RequestSecurityError('INVALID_SESSION_PAYLOAD', 'Session payload is incomplete.');
  }

  if (new Date(payload.expiresAt).getTime() <= now.getTime()) {
    throw new RequestSecurityError('SESSION_EXPIRED', 'Session has expired.');
  }

  return payload;
}

export function assertCsrfToken({ session, csrfToken }) {
  if (!session.csrfToken || !csrfToken || session.csrfToken !== csrfToken) {
    throw new RequestSecurityError('CSRF_TOKEN_INVALID', 'CSRF token is invalid.');
  }
}

export function createFixedWindowRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const buckets = new Map();

  return {
    check(key) {
      const current = now();
      const bucket = buckets.get(key);

      if (!bucket || bucket.resetAt <= current) {
        buckets.set(key, { count: 1, resetAt: current + windowMs });
        return { allowed: true, remaining: limit - 1 };
      }

      if (bucket.count >= limit) {
        throw new RequestSecurityError('RATE_LIMIT_EXCEEDED', 'Too many requests.');
      }

      bucket.count += 1;
      return { allowed: true, remaining: limit - bucket.count };
    },
  };
}

export function assertSecureRequest({ sessionToken, sessionSecret, csrfToken, rateLimiter, rateLimitKey, now = new Date() }) {
  const session = verifySignedSession(sessionToken, sessionSecret, now);
  assertCsrfToken({ session, csrfToken });
  rateLimiter?.check(rateLimitKey ?? session.sub);
  return session;
}

export function createCsrfToken() {
  return randomBytes(32).toString('base64url');
}
