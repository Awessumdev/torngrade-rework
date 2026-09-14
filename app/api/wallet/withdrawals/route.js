import { requestManualWithdrawal } from '../../../../src/withdrawals/withdrawal-service.mjs';
import { listUserWithdrawals, serializeWallet } from '../../../../src/wallet/wallet-views.mjs';
import { handleApi, json, parseTake, readJson, requireUser } from '../../../../src/http/api-helpers.mjs';
import { prisma } from '../../../../src/http/prisma.mjs';

export async function GET(request) {
  return handleApi(async () => {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const withdrawals = await listUserWithdrawals({
      db: prisma,
      user,
      take: parseTake(url.searchParams),
      cursor: url.searchParams.get('cursor'),
      status: url.searchParams.get('status'),
    });
    return json({ withdrawals });
  });
}

export async function POST(request) {
  return handleApi(async () => {
    const user = await requireUser(request);
    const body = await readJson(request);
    const result = await requestManualWithdrawal({ db: prisma, user, request: body });
    return json({
      withdrawal: result.withdrawal,
      wallet: serializeWallet(result.wallet),
      idempotent: result.idempotent,
    }, { status: result.idempotent ? 200 : 201 });
  });
}
