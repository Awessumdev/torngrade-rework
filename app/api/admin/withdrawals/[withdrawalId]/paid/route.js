import { markWithdrawalPaidByAdmin } from '../../../../../../src/withdrawals/withdrawal-service.mjs';
import { handleApi, json, readJson, requireAdmin } from '../../../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../../../src/http/prisma.mjs';

export async function POST(request, { params }) {
  return handleApi(async () => {
    const admin = await requireAdmin(request);
    const body = await readJson(request);
    const resolvedParams = await params;
    const result = await markWithdrawalPaidByAdmin({
      db: prisma,
      admin,
      withdrawalId: resolvedParams.withdrawalId,
      providerPayoutId: body.providerPayoutId,
      transferProof: body.transferProof,
    });
    return json(result);
  });
}
