import { authenticateTornIdentity } from '../../../../src/auth/authorization.mjs';
import { handleApi, json, readJson } from '../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../src/http/prisma.mjs';

export async function POST(request) {
  return handleApi(async () => {
    const body = await readJson(request);
    const user = await authenticateTornIdentity({ db: prisma, tornIdentity: body });
    return json({
      user: {
        id: user.id,
        externalTornId: user.externalTornId,
        username: user.username,
        status: user.status,
        createdAt: user.createdAt,
      },
    });
  });
}
