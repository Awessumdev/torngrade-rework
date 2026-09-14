import {
  setGlobalBettingStatus,
  updateBettingRiskLimits,
} from '../../../../../src/system/system-config.mjs';
import { handleApi, json, readJson, requireAdmin } from '../../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../../src/http/prisma.mjs';

export async function PATCH(request) {
  return handleApi(async () => {
    const admin = await requireAdmin(request);
    const body = await readJson(request);

    if (body.limits) {
      const config = await updateBettingRiskLimits({
        db: prisma,
        admin,
        limits: body.limits,
      });
      return json({ config });
    }

    const config = await setGlobalBettingStatus({
      db: prisma,
      admin,
      status: body.status,
      reason: body.reason ?? null,
    });
    return json({ config });
  });
}
