import { ADMIN_STATUS } from '../../../../src/auth/authorization.mjs';
import { verifyPassword } from '../../../../src/auth/passwords.mjs';
import { enforceRateLimit, handleApi, json, readJson } from '../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../src/http/prisma.mjs';
import { buildSessionToken, setSessionCookie } from '../../../../src/http/session-auth.mjs';

export async function POST(request) {
  return handleApi(async () => {
    enforceRateLimit(request, 'auth', 'admin-login');
    const body = await readJson(request);
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');

    const admin = await prisma.adminUser.findUnique({ where: { email } });
    if (!admin || admin.status !== ADMIN_STATUS.ACTIVE || !isValidAdminPassword(password, admin.passwordHash)) {
      return json({ error: { code: 'ADMIN_LOGIN_FAILED', message: 'Invalid admin credentials.' } }, { status: 401 });
    }

    const session = buildSessionToken({ subjectId: admin.id, type: 'ADMIN' });
    await setSessionCookie({ ...session, type: 'ADMIN' });

    return json({
      admin: {
        id: admin.id,
        email: admin.email,
        roles: admin.roles,
      },
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    });
  });
}

function isValidAdminPassword(password, passwordHash) {
  try {
    return verifyPassword(password, passwordHash);
  } catch {
    return false;
  }
}
