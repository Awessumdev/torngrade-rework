import { authenticateTornIdentity } from '../../../../src/auth/authorization.mjs';
import { verifyTornAuthRequest } from '../../../../src/auth/torn-verification.mjs';
import { handleApi, json } from '../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../src/http/prisma.mjs';
import { buildSessionToken, setSessionCookie } from '../../../../src/http/session-auth.mjs';

export async function POST(request) {
  return handleApi(async () => {
    const rawBody = await request.text();
    const tornIdentity = await verifyTornAuthRequest({
      rawBody,
      headers: request.headers,
    });
    const user = await authenticateTornIdentity({ db: prisma, tornIdentity });
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
