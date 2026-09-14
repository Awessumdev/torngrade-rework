import { randomUUID } from 'node:crypto';
import { assertCanAccessProduction, isAdminAllowed, ADMIN_ROLES } from '../auth/authorization.mjs';
import {
  moneyToString,
  parseMoney,
  requestWithdrawal as moveFundsToPendingWithdrawal,
  markWithdrawalPaid as clearPaidPendingWithdrawal,
  refundWithdrawal as releasePendingWithdrawal,
} from '../wallet/wallet-service.mjs';

export class WithdrawalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WithdrawalError';
    this.code = code;
  }
}

export function assertAdminCanProcessWithdrawals(admin) {
  if (!isAdminAllowed(admin, ADMIN_ROLES.PAYMENTS_APPROVER)) {
    throw new WithdrawalError('ADMIN_FORBIDDEN', 'Admin is not allowed to process withdrawals.');
  }
}

export function normalizeWithdrawalRequest(input) {
  const allowedKeys = new Set(['amount', 'idempotencyKey']);
  for (const key of Object.keys(input ?? {})) {
    if (!allowedKeys.has(key)) {
      throw new WithdrawalError('CLIENT_FIELD_NOT_ALLOWED', `Client cannot submit ${key}.`);
    }
  }

  if (!input?.idempotencyKey) {
    throw new WithdrawalError('IDEMPOTENCY_KEY_REQUIRED', 'Withdrawal request requires idempotency key.');
  }

  return {
    amount: moneyToString(parseMoney(input.amount)),
    idempotencyKey: String(input.idempotencyKey),
  };
}

function normalizeTransferProof({ providerPayoutId, transferProof }) {
  const payoutId = String(providerPayoutId ?? '').trim();

  if (!payoutId) {
    throw new WithdrawalError('PROVIDER_PAYOUT_ID_REQUIRED', 'Manual payout reference is required.');
  }

  if (!transferProof || typeof transferProof !== 'object') {
    throw new WithdrawalError('TRANSFER_PROOF_REQUIRED', 'Manual transfer proof is required.');
  }

  const reference = String(transferProof.reference ?? '').trim();
  const performedAt = String(transferProof.performedAt ?? '').trim();

  if (!reference || !performedAt) {
    throw new WithdrawalError('TRANSFER_PROOF_REQUIRED', 'Manual transfer proof reference and performedAt are required.');
  }

  return {
    providerPayoutId: payoutId,
    transferProof: { ...transferProof, reference, performedAt },
  };
}

export async function requestManualWithdrawal({ db, user, request, now = new Date() }) {
  assertCanAccessProduction(user);
  const normalized = normalizeWithdrawalRequest(request);

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'withdrawal-request:' + user.id + ':' + normalized.idempotencyKey}))`;

    const existing = await tx.withdrawal.findFirst({
      where: { userId: user.id, idempotencyKey: normalized.idempotencyKey },
    });

    if (existing) {
      return { withdrawal: existing, ledger: null, wallet: null, idempotent: true };
    }

    const withdrawalId = randomUUID();
    const { wallet: updatedWallet, ledger } = await moveFundsToPendingWithdrawal(
      { $transaction: async (fn) => fn(tx) },
      {
        userId: user.id,
        amount: normalized.amount,
        withdrawalId,
        idempotencyKey: `withdrawal-request:${withdrawalId}`,
        metadata: { payoutMethod: 'MANUAL' },
      },
    );

    const withdrawal = await tx.withdrawal.create({
      data: {
        id: withdrawalId,
        userId: user.id,
        idempotencyKey: normalized.idempotencyKey,
        amount: normalized.amount,
        currency: updatedWallet.currency,
        status: 'PENDING',
        payoutMethod: 'MANUAL',
        requestedAt: now,
      },
    });

    await tx.auditLog.create({
      data: {
        actorType: 'USER',
        actorUserId: user.id,
        action: 'WITHDRAWAL_REQUESTED',
        resourceType: 'Withdrawal',
        resourceId: withdrawalId,
        after: { status: 'PENDING', amount: normalized.amount, payoutMethod: 'MANUAL' },
      },
    });

    return { withdrawal, ledger, wallet: updatedWallet, idempotent: false };
  });
}

export async function markWithdrawalPaidByAdmin({
  db,
  admin,
  withdrawalId,
  providerPayoutId,
  transferProof,
  now = new Date(),
}) {
  assertAdminCanProcessWithdrawals(admin);
  const proof = normalizeTransferProof({ providerPayoutId, transferProof });

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT * FROM "Withdrawal"
      WHERE "id" = ${withdrawalId}::uuid
      FOR UPDATE
    `;
    const withdrawal = Array.isArray(rows) ? rows[0] : rows;

    if (!withdrawal) {
      throw new WithdrawalError('WITHDRAWAL_NOT_FOUND', 'Withdrawal does not exist.');
    }

    if (withdrawal.status === 'PAID') {
      return { withdrawal, ledger: null, wallet: null, idempotent: true };
    }

    if (withdrawal.status !== 'PENDING') {
      throw new WithdrawalError('WITHDRAWAL_NOT_PAYABLE', 'Only PENDING withdrawals can be marked paid.');
    }

    const { wallet, ledger } = await clearPaidPendingWithdrawal(
      { $transaction: async (fn) => fn(tx) },
      {
        userId: withdrawal.userId,
        amount: String(withdrawal.amount),
        withdrawalId,
        idempotencyKey: `withdrawal-paid:${withdrawalId}`,
        metadata: { providerPayoutId: proof.providerPayoutId, payoutMethod: 'MANUAL', transferProof: proof.transferProof },
      },
    );

    const updatedWithdrawal = await tx.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: 'PAID',
        providerPayoutId: proof.providerPayoutId,
        paidLedgerEntryId: ledger.id,
        paidAt: now,
      },
    });

    await tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorAdminId: admin.id,
        action: 'WITHDRAWAL_MARK_PAID',
        resourceType: 'Withdrawal',
        resourceId: withdrawalId,
        before: { status: withdrawal.status },
        after: { status: 'PAID', providerPayoutId: proof.providerPayoutId },
        metadata: { transferProof: proof.transferProof },
      },
    });

    return { withdrawal: updatedWithdrawal, ledger, wallet, idempotent: false };
  });
}

export async function rejectWithdrawalByAdmin({
  db,
  admin,
  withdrawalId,
  reason = null,
  now = new Date(),
}) {
  assertAdminCanProcessWithdrawals(admin);

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT * FROM "Withdrawal"
      WHERE "id" = ${withdrawalId}::uuid
      FOR UPDATE
    `;
    const withdrawal = Array.isArray(rows) ? rows[0] : rows;

    if (!withdrawal) {
      throw new WithdrawalError('WITHDRAWAL_NOT_FOUND', 'Withdrawal does not exist.');
    }

    if (withdrawal.status === 'REJECTED') {
      return { withdrawal, ledger: null, wallet: null, idempotent: true };
    }

    if (withdrawal.status !== 'PENDING') {
      throw new WithdrawalError('WITHDRAWAL_NOT_REJECTABLE', 'Only PENDING withdrawals can be rejected.');
    }

    const { wallet, ledger } = await releasePendingWithdrawal(
      { $transaction: async (fn) => fn(tx) },
      {
        userId: withdrawal.userId,
        amount: String(withdrawal.amount),
        withdrawalId,
        idempotencyKey: `withdrawal-refund:${withdrawalId}`,
        metadata: { reason },
      },
    );

    const updatedWithdrawal = await tx.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: 'REJECTED',
        refundLedgerEntryId: ledger.id,
        rejectedAt: now,
      },
    });

    await tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorAdminId: admin.id,
        action: 'WITHDRAWAL_REJECTED',
        resourceType: 'Withdrawal',
        resourceId: withdrawalId,
        before: { status: withdrawal.status },
        after: { status: 'REJECTED', reason },
      },
    });

    return { withdrawal: updatedWithdrawal, ledger, wallet, idempotent: false };
  });
}
