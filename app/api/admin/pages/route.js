import { getAdminPages, listAdminPage } from '../../../../src/admin/admin-dashboard.mjs';
import { handleApi, json, parseTake, requireAdmin } from '../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../src/http/prisma.mjs';

export async function GET(request) {
  return handleApi(async () => {
    const admin = await requireAdmin(request);
    const url = new URL(request.url);
    const page = url.searchParams.get('page');

    if (!page) {
      return json({ pages: getAdminPages({ admin }) });
    }

    const items = await listAdminPage({
      db: prisma,
      admin,
      page,
      take: parseTake(url.searchParams),
      cursor: url.searchParams.get('cursor'),
    });
    return json({ page, items });
  });
}
