import { authenticateTornIdentity } from '../../../../src/auth/authorization.mjs';
import { handleApi, json, readJson } from '../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../src/http/prisma.mjs';
import { buildSessionToken, setSessionCookie } from '../../../../src/http/session-auth.mjs';

export async function POST(request) {
  return handleApi(async () => {
    const body = await readJson(request);
    const user = await authenticateTornIdentity({ db: prisma, tornIdentity: body });
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
