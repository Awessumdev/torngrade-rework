import { placeBet } from '../../../src/betting/bet-service.mjs';
import { listUserBets } from '../../../src/users/user-bets.mjs';
import { handleApi, json, parseTake, readJson, requireUser } from '../../../src/http/api-helpers.mjs';
import { prisma } from '../../../src/http/prisma.mjs';

export async function GET(request) {
  return handleApi(async () => {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const bets = await listUserBets({
      db: prisma,
      user,
      status: url.searchParams.get('status') ?? undefined,
      take: parseTake(url.searchParams),
      cursor: url.searchParams.get('cursor'),
    });
    return json({ bets });
  });
}

export async function POST(request) {
  return handleApi(async () => {
    const user = await requireUser(request);
    const body = await readJson(request);
    const result = await placeBet({ db: prisma, user, request: body });
    return json({
      bet: {
        id: result.bet.id,
        acceptedOdds: String(result.bet.oddsSnapshot),
        stake: String(result.bet.stake),
        potentialPayout: String(result.bet.potentialPayout),
        placedAt: result.bet.placedAt,
      },
      wallet: {
        availableBalance: String(result.wallet.availableBalance),
        pendingWithdrawal: String(result.wallet.pendingWithdrawal),
      },
    }, { status: 201 });
  });
}
