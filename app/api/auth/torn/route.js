import { authenticateTornIdentity } from '../../../../src/auth/authorization.mjs';
import { verifyTornAuthRequest } from '../../../../src/auth/torn-verification.mjs';
import { enforceRateLimit, handleApi, json } from '../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../src/http/prisma.mjs';
import { buildSessionToken, setSessionCookie } from '../../../../src/http/session-auth.mjs';
import { ensureUserWallet } from '../../../../src/wallet/wallet-views.mjs';

export async function POST(request) {
  return handleApi(async () => {
    enforceRateLimit(request, 'auth', 'torn-login');
    const rawBody = await request.text();
    const tornIdentity = await verifyTornAuthRequest({
      rawBody,
      headers: request.headers,
    });
    const user = await authenticateTornIdentity({ db: prisma, tornIdentity });
    await ensureUserWallet({ db: prisma, userId: user.id });
    const session = buildSessionToken({ subjectId: user.id, type: 'USER' });
    await setSessionCookie({ ...session, type: 'USER' });
    return json({
      user: {
        id: user.id,
        externalTornId: user.externalTornId,
        username: user.username,
        status: user.status,
        createdAt: user.createdAt,
      },
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    });
  });
}
