import {
  getAdminMarketOddsSummary,
  updateOpenMarketOutcomeOdds,
} from '../../../../../../src/markets/odds-service.mjs';
import { handleApi, json, readJson, requireAdmin } from '../../../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../../../src/http/prisma.mjs';

export async function GET(request, { params }) {
  return handleApi(async () => {
    await requireAdmin(request);
    const resolvedParams = await params;
    const summary = await getAdminMarketOddsSummary({ db: prisma, marketId: resolvedParams.marketId });
    return json({ summary });
  });
}

export async function PATCH(request) {
  return handleApi(async () => {
    const admin = await requireAdmin(request);
    const body = await readJson(request);
    const result = await updateOpenMarketOutcomeOdds({
      db: prisma,
      admin,
      outcomeId: body.outcomeId,
      newOdds: body.newOdds,
      reason: body.reason ?? null,
    });
    return json(result);
  });
}
