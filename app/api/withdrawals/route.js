import { requestManualWithdrawal } from '../../../src/withdrawals/withdrawal-service.mjs';
import { handleApi, json, readJson, requireUser } from '../../../src/http/api-helpers.mjs';
import { prisma } from '../../../src/http/prisma.mjs';

export async function POST(request) {
  return handleApi(async () => {
    const user = await requireUser(request);
    const body = await readJson(request);
    const result = await requestManualWithdrawal({ db: prisma, user, request: body });
    return json({
      withdrawal: result.withdrawal,
      wallet: result.wallet ? {
        availableBalance: String(result.wallet.availableBalance),
        pendingWithdrawal: String(result.wallet.pendingWithdrawal),
      } : null,
      idempotent: result.idempotent,
    }, { status: result.idempotent ? 200 : 201 });
  });
}
