import { json } from '../../../src/http/api-helpers.mjs';

export async function GET() {
  return json({ ok: true, service: 'torngrade-api' });
}
