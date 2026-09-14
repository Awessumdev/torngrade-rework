import { handleApi, json, requireUser } from '../../../src/http/api-helpers.mjs';

export async function GET(request) {
  return handleApi(async () => {
    const user = await requireUser(request);
    return json({
      user: {
        id: user.id,
        externalTornId: user.externalTornId,
        username: user.username,
        status: user.status,
        wallet: user.wallet ? {
          availableBalance: String(user.wallet.availableBalance),
          pendingWithdrawal: String(user.wallet.pendingWithdrawal),
          currency: user.wallet.currency,
        } : null,
      },
    });
  });
}
