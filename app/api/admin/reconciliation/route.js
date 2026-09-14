import { runReconciliation } from '../../../../src/reconciliation/reconciliation-service.mjs';
import { handleApi, json, readJson, requireAdmin } from '../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../src/http/prisma.mjs';

export async function POST(request) {
  return handleApi(async () => {
    const admin = await requireAdmin(request);
    const body = await readJson(request);
    const result = await runReconciliation({
      db: prisma,
      admin,
      actualAssets: body.actualAssets,
    });
    return json(result);
  });
}
