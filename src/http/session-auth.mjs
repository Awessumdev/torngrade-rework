import { cookies } from 'next/headers';
import {
  assertCsrfToken,
  createCsrfToken,
  signSessionPayload,
  verifySignedSession,
} from '../security/request-security.mjs';
import { ApiError } from './api-helpers.mjs';

export const USER_SESSION_COOKIE_NAME = 'torngrade_user_session';
export const ADMIN_SESSION_COOKIE_NAME = 'torngrade_admin_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export function getSessionSecret() {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new ApiError(500, 'SESSION_SECRET_MISSING', 'Session secret is not configured.');
  }
  return secret;
}

export function buildSessionToken({ subjectId, type, now = new Date() }) {
  const csrfToken = createCsrfToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const token = signSessionPayload({
    sub: subjectId,
    type,
    csrfToken,
    expiresAt,
  }, getSessionSecret());

  return { token, csrfToken, expiresAt };
}

export async function setSessionCookie({ token, expiresAt, type }) {
  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName(type), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export async function clearSessionCookie(type = null) {
  const cookieStore = await cookies();
  const names = type ? [sessionCookieName(type)] : [USER_SESSION_COOKIE_NAME, ADMIN_SESSION_COOKIE_NAME];
  for (const name of names) {
    cookieStore.set(name, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      expires: new Date(0),
    });
  }
}

export async function getSessionFromCookies(type, now = new Date()) {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName(type))?.value;
  if (!token) {
    throw new ApiError(401, 'SESSION_REQUIRED', 'Authenticated session is required.');
  }
  return verifySignedSession(token, getSessionSecret(), now);
}

export function sessionCookieName(type) {
  if (type === 'USER') return USER_SESSION_COOKIE_NAME;
  if (type === 'ADMIN') return ADMIN_SESSION_COOKIE_NAME;
  throw new ApiError(500, 'UNKNOWN_SESSION_TYPE', 'Session type is unknown.');
}

export function assertSessionType(session, type) {
  if (session.type !== type) {
    throw new ApiError(403, 'SESSION_TYPE_FORBIDDEN', 'Session type is not allowed for this resource.');
  }
}

export function assertRequestCsrf(request, session) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    return;
  }
  assertCsrfToken({
    session,
    csrfToken: request.headers.get('x-csrf-token'),
  });
}
