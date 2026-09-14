import { voidMarketWithRefundsAtomically } from '../../../../../../src/settlement/settlement-preview.mjs';
import { handleApi, json, readJson, requireAdmin } from '../../../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../../../src/http/prisma.mjs';

export async function POST(request, { params }) {
  return handleApi(async () => {
    const admin = await requireAdmin(request);
    const body = await readJson(request);
    const resolvedParams = await params;
    const result = await voidMarketWithRefundsAtomically({
      db: prisma,
      admin,
      marketId: resolvedParams.marketId,
      reason: body.reason ?? null,
    });
    return json(result);
  });
}
