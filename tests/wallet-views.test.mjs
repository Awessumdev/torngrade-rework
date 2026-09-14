import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureUserWallet,
  getUserWallet,
  listUserDeposits,
  listUserLedgerEntries,
  listUserWithdrawals,
} from '../src/wallet/wallet-views.mjs';

const user = {
  id: '00000000-0000-0000-0000-000000000001',
  status: 'ACTIVE',
};

test('ensures authenticated user has a real zero-balance wallet without creating ledger movement', async () => {
  const calls = [];
  const db = {
    wallet: {
      upsert: async (args) => {
        calls.push(args);
        return {
          id: 'wallet-1',
          userId: args.where.userId,
          availableBalance: args.create.availableBalance,
          pendingWithdrawal: args.create.pendingWithdrawal,
          currency: args.create.currency,
          status: args.create.status,
          version: 0,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        };
      },
    },
  };

  const wallet = await ensureUserWallet({ db, userId: user.id });

  assert.equal(wallet.availableBalance, '0');
  assert.equal(wallet.pendingWithdrawal, '0');
  assert.equal(wallet.currency, 'XAN');
  assert.equal(calls[0].where.userId, user.id);
});

test('wallet endpoint serializes only server-side wallet fields', async () => {
  const wallet = await getUserWallet({
    db: {
      wallet: {
        upsert: async () => assert.fail('existing wallet should be used'),
      },
    },
    user: {
      ...user,
      wallet: {
        id: 'wallet-1',
        availableBalance: '12.5',
        pendingWithdrawal: '2',
        currency: 'XAN',
        status: 'ACTIVE',
        version: 3,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
    },
  });

  assert.deepEqual(wallet, {
    id: 'wallet-1',
    availableBalance: '12.5',
    pendingWithdrawal: '2',
    currency: 'XAN',
    status: 'ACTIVE',
    version: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
});

test('wallet ledger list is scoped to authenticated user and supports filters', async () => {
  let query;
  const entries = await listUserLedgerEntries({
    db: {
      ledgerEntry: {
        findMany: async (args) => {
          query = args;
          return [{
            id: 'ledger-1',
            type: 'DEPOSIT',
            direction: 'CREDIT',
            amount: '4',
            balanceBefore: '0',
            balanceAfter: '4',
            currency: 'XAN',
            referenceType: 'Deposit',
            referenceId: 'deposit-1',
            metadata: { externalTransactionId: 'tx-1' },
            createdAt: new Date('2026-01-03T00:00:00Z'),
          }];
        },
      },
    },
    user,
    take: 25,
    cursor: 'ledger-cursor',
    type: 'DEPOSIT',
  });

  assert.equal(query.where.userId, user.id);
  assert.equal(query.where.type, 'DEPOSIT');
  assert.equal(query.take, 25);
  assert.deepEqual(query.cursor, { id: 'ledger-cursor' });
  assert.equal(query.skip, 1);
  assert.equal(entries[0].amount, '4');
  assert.equal(entries[0].createdAt, '2026-01-03T00:00:00.000Z');
});

test('deposit and withdrawal lists are scoped to authenticated user', async () => {
  const queries = [];
  const db = {
    deposit: {
      findMany: async (args) => {
        queries.push(['deposit', args]);
        return [{
          id: 'deposit-1',
          externalDepositId: 'external-1',
          amount: '8',
          currency: 'XAN',
          status: 'COMPLETED',
          completedAt: new Date('2026-01-04T00:00:00Z'),
          createdAt: new Date('2026-01-04T00:00:00Z'),
          updatedAt: new Date('2026-01-04T00:00:00Z'),
        }];
      },
    },
    withdrawal: {
      findMany: async (args) => {
        queries.push(['withdrawal', args]);
        return [{
          id: 'withdrawal-1',
          amount: '3',
          currency: 'XAN',
          status: 'PENDING',
          payoutMethod: 'MANUAL',
          providerPayoutId: null,
          requestedAt: new Date('2026-01-05T00:00:00Z'),
          paidAt: null,
          rejectedAt: null,
        }];
      },
    },
  };

  const deposits = await listUserDeposits({ db, user, status: 'COMPLETED' });
  const withdrawals = await listUserWithdrawals({ db, user, status: 'PENDING' });

  assert.deepEqual(queries.map(([name]) => name), ['deposit', 'withdrawal']);
  assert.deepEqual(queries[0][1].where, { userId: user.id, status: 'COMPLETED' });
  assert.deepEqual(queries[1][1].where, { userId: user.id, status: 'PENDING' });
  assert.equal(deposits[0].externalDepositId, 'external-1');
  assert.equal(withdrawals[0].payoutMethod, 'MANUAL');
});

test('suspended users cannot access wallet views', async () => {
  await assert.rejects(
    () => getUserWallet({ db: {}, user: { ...user, status: 'SUSPENDED' } }),
    { code: 'USER_NOT_ACTIVE' },
  );
});
