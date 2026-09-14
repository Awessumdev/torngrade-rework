import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

export class PasswordError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PasswordError';
    this.code = code;
  }
}

const PBKDF2_ITERATIONS = 210_000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';

export function hashPassword(password, salt = randomBytes(16).toString('base64url')) {
  const normalized = normalizePassword(password);
  const hash = pbkdf2Sync(normalized, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST).toString('base64url');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

export function verifyPassword(password, storedHash) {
  const normalized = normalizePassword(password);
  const [scheme, iterationsRaw, salt, expectedHash] = String(storedHash ?? '').split('$');

  if (scheme !== 'pbkdf2' || !iterationsRaw || !salt || !expectedHash) {
    throw new PasswordError('UNSUPPORTED_PASSWORD_HASH', 'Admin password hash format is unsupported.');
  }

  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations < 100_000) {
    throw new PasswordError('UNSUPPORTED_PASSWORD_HASH', 'Admin password hash parameters are unsupported.');
  }

  const actual = pbkdf2Sync(normalized, salt, iterations, KEY_LENGTH, DIGEST);
  const expected = Buffer.from(expectedHash, 'base64url');

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return false;
  }

  return true;
}

function normalizePassword(password) {
  const normalized = String(password ?? '');
  if (normalized.length < 12 || normalized.length > 256) {
    throw new PasswordError('INVALID_PASSWORD', 'Password length is invalid.');
  }
  return normalized;
}
