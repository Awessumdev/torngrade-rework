import { listUserDeposits } from '../../../../src/wallet/wallet-views.mjs';
import { handleApi, json, parseTake, requireUser } from '../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../src/http/prisma.mjs';

export async function GET(request) {
  return handleApi(async () => {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const deposits = await listUserDeposits({
      db: prisma,
      user,
      take: parseTake(url.searchParams),
      cursor: url.searchParams.get('cursor'),
      status: url.searchParams.get('status'),
    });
    return json({ deposits });
  });
}
