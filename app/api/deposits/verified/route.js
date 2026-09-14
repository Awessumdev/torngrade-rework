import { processVerifiedDeposit } from '../../../../src/wallet/deposit-pipeline.mjs';
import { enforceRateLimit, handleApi, json, readJson, requireSystemSecret } from '../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../src/http/prisma.mjs';

export async function POST(request) {
  return handleApi(async () => {
    enforceRateLimit(request, 'internalDeposit', 'verified-deposit');
    requireSystemSecret(request);
    const body = await readJson(request);
    const result = await processVerifiedDeposit(prisma, body);
    return json({
      deposit: result.deposit,
      wallet: result.wallet ? {
        availableBalance: String(result.wallet.availableBalance),
        pendingWithdrawal: String(result.wallet.pendingWithdrawal),
      } : null,
      idempotent: result.idempotent,
    }, { status: result.idempotent ? 200 : 201 });
  });
}
