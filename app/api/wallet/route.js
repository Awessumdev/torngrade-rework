import { getUserWallet } from '../../../src/wallet/wallet-views.mjs';
import { handleApi, json, requireUser } from '../../../src/http/api-helpers.mjs';
import { prisma } from '../../../src/http/prisma.mjs';

export async function GET(request) {
  return handleApi(async () => {
    const user = await requireUser(request);
    const wallet = await getUserWallet({ db: prisma, user });
    return json({ wallet });
  });
}
