import { getAdminDashboardMetrics } from '../../../../src/admin/admin-dashboard.mjs';
import { handleApi, json, requireAdmin } from '../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../src/http/prisma.mjs';

export async function GET(request) {
  return handleApi(async () => {
    const admin = await requireAdmin(request);
    const metrics = await getAdminDashboardMetrics({ db: prisma, admin });
    return json({ metrics });
  });
}
