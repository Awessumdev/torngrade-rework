import { getUserBetDetail } from '../../../../src/users/user-bets.mjs';
import { handleApi, json, requireUser } from '../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../src/http/prisma.mjs';

export async function GET(request, { params }) {
  return handleApi(async () => {
    const user = await requireUser(request);
    const resolvedParams = await params;
    const bet = await getUserBetDetail({ db: prisma, user, betId: resolvedParams.betId });
    return json({ bet });
  });
}
