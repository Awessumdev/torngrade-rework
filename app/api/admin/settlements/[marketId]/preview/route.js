import { createSettlementPreview } from '../../../../../../src/settlement/settlement-preview.mjs';
import { handleApi, json, requireAdmin } from '../../../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../../../src/http/prisma.mjs';

export async function GET(request, { params }) {
  return handleApi(async () => {
    const admin = await requireAdmin(request);
    const url = new URL(request.url);
    const winningOutcomeId = url.searchParams.get('winningOutcomeId');
    const resolvedParams = await params;
    const preview = await createSettlementPreview({
      db: prisma,
      admin,
      marketId: resolvedParams.marketId,
      winningOutcomeId,
    });
    return json({ preview });
  });
}
