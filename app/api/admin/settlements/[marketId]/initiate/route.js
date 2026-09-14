import { initiateSettlementWithConfirmation } from '../../../../../../src/settlement/settlement-preview.mjs';
import { handleApi, json, readJson, requireAdmin } from '../../../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../../../src/http/prisma.mjs';

export async function POST(request, { params }) {
  return handleApi(async () => {
    const admin = await requireAdmin(request);
    const body = await readJson(request);
    const resolvedParams = await params;
    const result = await initiateSettlementWithConfirmation({
      db: prisma,
      admin,
      marketId: resolvedParams.marketId,
      winningOutcomeId: body.winningOutcomeId,
      confirmation: body.confirmation,
    });
    return json(result, { status: 202 });
  });
}
