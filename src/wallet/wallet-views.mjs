import { assertCanAccessProduction } from '../auth/authorization.mjs';

export class WalletViewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WalletViewError';
    this.code = code;
  }
}

function decimalString(value) {
  return String(value);
}

function serializeDate(value) {
  return value ? new Date(value).toISOString() : null;
}

export function serializeWallet(wallet) {
  if (!wallet) return null;

  return {
    id: wallet.id,
    availableBalance: decimalString(wallet.availableBalance),
    pendingWithdrawal: decimalString(wallet.pendingWithdrawal),
    currency: wallet.currency,
    status: wallet.status,
    version: wallet.version,
    createdAt: serializeDate(wallet.createdAt),
    updatedAt: serializeDate(wallet.updatedAt),
  };
}

export function serializeLedgerEntry(entry) {
  return {
    id: entry.id,
    type: entry.type,
    direction: entry.direction,
    amount: decimalString(entry.amount),
    balanceBefore: decimalString(entry.balanceBefore),
    balanceAfter: decimalString(entry.balanceAfter),
    currency: entry.currency,
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    metadata: entry.metadata ?? null,
    createdAt: serializeDate(entry.createdAt),
  };
}

export function serializeDeposit(deposit) {
  return {
    id: deposit.id,
    externalDepositId: deposit.externalDepositId,
    amount: decimalString(deposit.amount),
    currency: deposit.currency,
    status: deposit.status,
    completedAt: serializeDate(deposit.completedAt),
    createdAt: serializeDate(deposit.createdAt),
    updatedAt: serializeDate(deposit.updatedAt),
  };
}

export function serializeWithdrawal(withdrawal) {
  return {
    id: withdrawal.id,
    amount: decimalString(withdrawal.amount),
    currency: withdrawal.currency,
    status: withdrawal.status,
    payoutMethod: withdrawal.payoutMethod,
    providerPayoutId: withdrawal.providerPayoutId ?? null,
    requestedAt: serializeDate(withdrawal.requestedAt),
    paidAt: serializeDate(withdrawal.paidAt),
    rejectedAt: serializeDate(withdrawal.rejectedAt),
  };
}

export async function ensureUserWallet({ db, userId }) {
  return db.wallet.upsert({
    where: { userId },
    create: {
      userId,
      availableBalance: '0',
      pendingWithdrawal: '0',
      currency: 'XAN',
      status: 'ACTIVE',
    },
    update: {},
  });
}

export async function getUserWallet({ db, user }) {
  assertCanAccessProduction(user);
  const wallet = user.wallet ?? await ensureUserWallet({ db, userId: user.id });
  return serializeWallet(wallet);
}

function cursorClause(cursor) {
  return cursor ? { id: String(cursor) } : undefined;
}

export async function listUserLedgerEntries({ db, user, take = 50, cursor = null, type = null }) {
  assertCanAccessProduction(user);

  const where = {
    userId: user.id,
    ...(type ? { type: String(type) } : {}),
  };

  const entries = await db.ledgerEntry.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    ...(cursor ? { cursor: cursorClause(cursor), skip: 1 } : {}),
  });

  return entries.map(serializeLedgerEntry);
}

export async function listUserDeposits({ db, user, take = 50, cursor = null, status = null }) {
  assertCanAccessProduction(user);

  const deposits = await db.deposit.findMany({
    where: {
      userId: user.id,
      ...(status ? { status: String(status) } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
    ...(cursor ? { cursor: cursorClause(cursor), skip: 1 } : {}),
  });

  return deposits.map(serializeDeposit);
}

export async function listUserWithdrawals({ db, user, take = 50, cursor = null, status = null }) {
  assertCanAccessProduction(user);

  const withdrawals = await db.withdrawal.findMany({
    where: {
      userId: user.id,
      ...(status ? { status: String(status) } : {}),
    },
    orderBy: { requestedAt: 'desc' },
    take,
    ...(cursor ? { cursor: cursorClause(cursor), skip: 1 } : {}),
  });

  return withdrawals.map(serializeWithdrawal);
}
