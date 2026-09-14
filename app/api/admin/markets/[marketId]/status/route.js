import { transitionMarketStatus } from '../../../../../../src/markets/market-lifecycle.mjs';
import { handleApi, json, readJson, requireAdmin } from '../../../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../../../src/http/prisma.mjs';

export async function PATCH(request, { params }) {
  return handleApi(async () => {
    const admin = await requireAdmin(request);
    const body = await readJson(request);
    const resolvedParams = await params;
    const market = await transitionMarketStatus({
      db: prisma,
      admin,
      marketId: resolvedParams.marketId,
      toStatus: body.toStatus,
      reason: body.reason ?? null,
    });
    return json({ market });
  });
}
