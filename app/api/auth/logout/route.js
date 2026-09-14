import { handleApi, json } from '../../../../src/http/api-helpers.mjs';
import { clearSessionCookie } from '../../../../src/http/session-auth.mjs';

export async function POST(request) {
  return handleApi(async () => {
    const body = await request.json().catch(() => ({}));
    await clearSessionCookie(body.type ?? null);
    return json({ ok: true });
  });
}
