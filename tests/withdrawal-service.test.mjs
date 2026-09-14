import assert from 'node:assert/strict';
import {
  markWithdrawalPaidByAdmin,
  normalizeWithdrawalRequest,
  rejectWithdrawalByAdmin,
  requestManualWithdrawal,
} from '../src/withdrawals/withdrawal-service.mjs';
import { ADMIN_ROLES, ADMIN_STATUS, USER_STATUS, WHITELIST_STATUS } from '../src/auth/authorization.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const user = {
  id: '00000000-0000-0000-0000-000000000001',
  status: USER_STATUS.ACTIVE,
  whitelistEntries: [{ status: WHITELIST_STATUS.ACTIVE }],
};
const admin = {
  id: '00000000-0000-0000-0000-00000000a001',
  status: ADMIN_STATUS.ACTIVE,
  roles: [ADMIN_ROLES.PAYMENTS_APPROVER],
};
const withdrawalId = '00000000-0000-0000-0000-0000000000aa';

function createRequestDb({ existingWithdrawal = null, availableBalance = '5', pendingWithdrawal = '0' } = {}) {
  const calls = [];
  let wallet = {
    id: 'wallet-1',
    userId: user.id,
    currency: 'XAN',
    availableBalance,
    pendingWithdrawal,
    status: 'ACTIVE',
  };

  return {
    calls,
    db: {
      $transaction: async (fn) => fn({
        withdrawal: {
          findFirst: async () => {
            calls.push(['findExistingWithdrawal']);
            return existingWithdrawal;
          },
          create: async ({ data }) => {
            calls.push(['createWithdrawal', data]);
            return { ...data };
          },
        },
        $queryRaw: async () => {
          calls.push(['lockWallet']);
          return [wallet];
        },
        $executeRaw: async (strings) => {
          const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
          calls.push([sql.includes('pg_advisory_xact_lock') ? 'lockWithdrawalRequest' : 'allowWalletMutation']);
          return 1;
        },
        ledgerEntry: {
          create: async ({ data }) => {
            calls.push(['ledger', data]);
            return { id: 'ledger-1', ...data };
          },
        },
        wallet: {
          update: async ({ data }) => {
            calls.push(['walletUpdate', data]);
            wallet = { ...wallet, availableBalance: data.availableBalance, pendingWithdrawal: data.pendingWithdrawal };
            return { ...wallet };
          },
        },
        auditLog: {
          create: async ({ data }) => {
            calls.push(['audit', data]);
            return { id: 'audit-1', ...data };
          },
        },
      }),
    },
  };
}

function createAdminDb({ status = 'PENDING', amount = '2', availableBalance = '3', pendingWithdrawal = '2' } = {}) {
  const calls = [];
  const withdrawal = {
    id: withdrawalId,
    userId: user.id,
    amount,
    currency: 'XAN',
    status,
    providerPayoutId: status === 'PAID' ? 'manual-tx-1' : null,
  };
  let wallet = {
    id: 'wallet-1',
    userId: user.id,
    currency: 'XAN',
    availableBalance,
    pendingWithdrawal,
    status: 'ACTIVE',
  };

  return {
    calls,
    db: {
      $transaction: async (fn) => fn({
        $queryRaw: async (strings) => {
          const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
          if (sql.includes('"Withdrawal"')) {
            calls.push(['lockWithdrawal']);
            return [withdrawal];
          }
          if (sql.includes('"Wallet"')) {
            calls.push(['lockWallet']);
            return [wallet];
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
        $executeRaw: async () => {
          calls.push(['allowWalletMutation']);
          return 1;
        },
        ledgerEntry: {
          create: async ({ data }) => {
            calls.push(['ledger', data]);
            return { id: 'ledger-1', ...data };
          },
        },
        wallet: {
          update: async ({ data }) => {
            calls.push(['walletUpdate', data]);
            wallet = { ...wallet, availableBalance: data.availableBalance, pendingWithdrawal: data.pendingWithdrawal };
            return { ...wallet };
          },
        },
        withdrawal: {
          update: async ({ data }) => {
            calls.push(['updateWithdrawal', data]);
            return { ...withdrawal, ...data };
          },
        },
        auditLog: {
          create: async ({ data }) => {
            calls.push(['audit', data]);
            return { id: 'audit-1', ...data };
          },
        },
      }),
    },
  };
}

test('normalizes withdrawal request and rejects client-controlled fields', () => {
  assert.deepEqual(normalizeWithdrawalRequest({ amount: '2.000', idempotencyKey: 'wd:1' }), {
    amount: '2',
    idempotencyKey: 'wd:1',
  });

  assert.throws(
    () => normalizeWithdrawalRequest({ amount: '2', idempotencyKey: 'wd:1', status: 'PAID' }),
    (error) => error.code === 'CLIENT_FIELD_NOT_ALLOWED',
  );
});

test('user withdrawal request moves available to pending, creates PENDING manual withdrawal, ledger, and audit', async () => {
  const { db, calls } = createRequestDb({ availableBalance: '5', pendingWithdrawal: '1' });

  const result = await requestManualWithdrawal({
    db,
    user,
    request: { amount: '2', idempotencyKey: 'wd:1' },
    now: new Date('2026-09-13T15:00:00.000Z'),
  });

  assert.equal(result.idempotent, false);
  assert.equal(result.wallet.availableBalance, '3');
  assert.equal(result.wallet.pendingWithdrawal, '3');
  assert.equal(result.withdrawal.status, 'PENDING');
  assert.equal(result.withdrawal.payoutMethod, 'MANUAL');
  assert.equal(result.ledger.type, 'WITHDRAWAL_REQUEST');
  assert.deepEqual(calls.map(([name]) => name), [
    'lockWithdrawalRequest',
    'findExistingWithdrawal',
    'lockWallet',
    'allowWalletMutation',
    'ledger',
    'walletUpdate',
    'createWithdrawal',
    'audit',
  ]);
});

test('duplicate withdrawal request is idempotent and does not move funds twice', async () => {
  const existingWithdrawal = { id: withdrawalId, userId: user.id, status: 'PENDING', amount: '2' };
  const { db, calls } = createRequestDb({ existingWithdrawal });

  const result = await requestManualWithdrawal({
    db,
    user,
    request: { amount: '2', idempotencyKey: 'wd:1' },
  });

  assert.equal(result.idempotent, true);
  assert.deepEqual(calls.map(([name]) => name), ['lockWithdrawalRequest', 'findExistingWithdrawal']);
});

test('admin mark paid clears pending withdrawal, creates WITHDRAWAL_PAID ledger, updates withdrawal, and audits', async () => {
  const { db, calls } = createAdminDb({ status: 'PENDING', availableBalance: '3', pendingWithdrawal: '2' });

  const result = await markWithdrawalPaidByAdmin({
    db,
    admin,
    withdrawalId,
    providerPayoutId: 'manual-transfer-1',
    transferProof: { reference: 'bank-receipt-1', performedAt: '2026-09-13T15:10:00.000Z' },
  });

  assert.equal(result.idempotent, false);
  assert.equal(result.wallet.availableBalance, '3');
  assert.equal(result.wallet.pendingWithdrawal, '0');
  assert.equal(result.ledger.type, 'WITHDRAWAL_PAID');
  assert.equal(result.withdrawal.status, 'PAID');
  assert.equal(result.withdrawal.providerPayoutId, 'manual-transfer-1');
  assert.equal(calls.at(-1)[1].action, 'WITHDRAWAL_MARK_PAID');
});

test('same withdrawal cannot be marked PAID twice', async () => {
  const { db, calls } = createAdminDb({ status: 'PAID' });

  const result = await markWithdrawalPaidByAdmin({
    db,
    admin,
    withdrawalId,
    providerPayoutId: 'manual-transfer-1',
    transferProof: { reference: 'bank-receipt-1', performedAt: '2026-09-13T15:10:00.000Z' },
  });

  assert.equal(result.idempotent, true);
  assert.deepEqual(calls.map(([name]) => name), ['lockWithdrawal']);
});

test('admin reject safely refunds pending funds and audits', async () => {
  const { db, calls } = createAdminDb({ status: 'PENDING', availableBalance: '3', pendingWithdrawal: '2' });

  const result = await rejectWithdrawalByAdmin({
    db,
    admin,
    withdrawalId,
    reason: 'manual review failed',
  });

  assert.equal(result.idempotent, false);
  assert.equal(result.wallet.availableBalance, '5');
  assert.equal(result.wallet.pendingWithdrawal, '0');
  assert.equal(result.ledger.type, 'WITHDRAWAL_REFUND');
  assert.equal(result.withdrawal.status, 'REJECTED');
  assert.equal(calls.at(-1)[1].action, 'WITHDRAWAL_REJECTED');
});

test('already rejected withdrawal does not refund twice', async () => {
  const { db, calls } = createAdminDb({ status: 'REJECTED', availableBalance: '5', pendingWithdrawal: '0' });

  const result = await rejectWithdrawalByAdmin({ db, admin, withdrawalId });

  assert.equal(result.idempotent, true);
  assert.deepEqual(calls.map(([name]) => name), ['lockWithdrawal']);
});

test('non approver admin cannot process withdrawals', async () => {
  const { db } = createAdminDb();
  const badAdmin = { id: admin.id, status: ADMIN_STATUS.ACTIVE, roles: [ADMIN_ROLES.AUDITOR] };

  await assert.rejects(
    () => markWithdrawalPaidByAdmin({ db, admin: badAdmin, withdrawalId, providerPayoutId: 'x' }),
    (error) => error.code === 'ADMIN_FORBIDDEN',
  );
});

test('admin mark paid requires manual transfer proof', async () => {
  const { db } = createAdminDb({ status: 'PENDING' });

  await assert.rejects(
    () => markWithdrawalPaidByAdmin({ db, admin, withdrawalId, providerPayoutId: 'manual-transfer-1' }),
    (error) => error.code === 'TRANSFER_PROOF_REQUIRED',
  );
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
