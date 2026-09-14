import assert from 'node:assert/strict';
import {
  DepositPipelineError,
  normalizeVerifiedDeposit,
  processVerifiedDeposit,
} from '../src/wallet/deposit-pipeline.mjs';
import { LEDGER_ENTRY_TYPES } from '../src/wallet/wallet-service.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const userId = '00000000-0000-0000-0000-000000000001';
const walletId = '00000000-0000-0000-0000-0000000000aa';
const depositId = '00000000-0000-0000-0000-0000000000dd';
const ledgerId = '00000000-0000-0000-0000-0000000000ee';

function createPipelineDb({
  existingDeposit = null,
  wallet = {
    id: walletId,
    userId,
    currency: 'XAN',
    availableBalance: '2',
    pendingWithdrawal: '0',
    status: 'ACTIVE',
  },
  failCreateWithUnique = false,
  duplicateLookupDeposit = null,
} = {}) {
  const calls = [];
  let depositRecord = existingDeposit;
  let storedWallet = { ...wallet };

  const tx = {
    $queryRaw: async (strings) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('"Deposit"')) {
        calls.push(['lockDeposit']);
        return depositRecord ? [{ ...depositRecord }] : [];
      }
      if (sql.includes('"Wallet"')) {
        calls.push(['lockWallet']);
        return [{ ...storedWallet }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    $executeRaw: async () => {
      calls.push(['allowWalletMutation']);
      return 1;
    },
    deposit: {
      create: async ({ data }) => {
        calls.push(['createDeposit', data]);
        if (failCreateWithUnique) {
          const error = new Error('Unique constraint failed');
          error.code = 'P2002';
          throw error;
        }
        depositRecord = {
          id: depositId,
          ...data,
          completedAt: null,
          creditedLedgerEntryId: null,
        };
        return { ...depositRecord };
      },
      update: async ({ where, data }) => {
        calls.push(['completeDeposit', { where, data }]);
        depositRecord = {
          ...depositRecord,
          ...data,
        };
        return { ...depositRecord };
      },
    },
    ledgerEntry: {
      create: async ({ data }) => {
        calls.push(['ledger', data]);
        return { id: ledgerId, ...data };
      },
    },
    wallet: {
      update: async ({ data }) => {
        calls.push(['walletUpdate', data]);
        storedWallet = {
          ...storedWallet,
          availableBalance: data.availableBalance,
          pendingWithdrawal: data.pendingWithdrawal ?? storedWallet.pendingWithdrawal,
        };
        return { ...storedWallet };
      },
    },
  };

  return {
    calls,
    db: {
      $transaction: async (fn) => fn(tx),
      deposit: {
        findUnique: async () => duplicateLookupDeposit,
      },
    },
  };
}

test('normalizes verified external deposit identity', () => {
  assert.deepEqual(
    normalizeVerifiedDeposit({
      userId,
      externalTransactionId: ' ext-123 ',
      amount: '1',
      currency: 'XAN',
      verified: true,
    }),
    {
      userId,
      externalTransactionId: 'ext-123',
      providerEventId: null,
      amount: '1',
      currency: 'XAN',
      metadata: undefined,
    },
  );

  assert.throws(
    () => normalizeVerifiedDeposit({ userId, amount: '1' }),
    (error) => error instanceof DepositPipelineError && error.code === 'INVALID_EXTERNAL_TRANSACTION_ID',
  );

  assert.throws(
    () => normalizeVerifiedDeposit({
      userId,
      externalTransactionId: 'ext-123',
      amount: '1',
      currency: 'XAN',
    }),
    (error) => error instanceof DepositPipelineError && error.code === 'DEPOSIT_NOT_VERIFIED',
  );
});

test('verified external deposit creates deposit, locks wallet, credits balance, writes DEPOSIT ledger, then completes', async () => {
  const { db, calls } = createPipelineDb();

  const result = await processVerifiedDeposit(db, {
    userId,
    externalTransactionId: 'chain-tx-1',
    providerEventId: 'event-1',
    amount: '3',
    currency: 'XAN',
    verified: true,
  });

  assert.equal(result.idempotent, false);
  assert.equal(result.wallet.availableBalance, '5');
  assert.deepEqual(calls.map(([name]) => name), [
    'lockDeposit',
    'createDeposit',
    'lockWallet',
    'allowWalletMutation',
    'ledger',
    'walletUpdate',
    'completeDeposit',
  ]);
  assert.equal(calls[4][1].type, LEDGER_ENTRY_TYPES.DEPOSIT);
  assert.equal(calls[4][1].referenceId, depositId);
  assert.equal(calls[4][1].idempotencyKey, 'deposit:chain-tx-1');
  assert.equal(calls[6][1].data.status, 'COMPLETED');
  assert.equal(calls[6][1].data.creditedLedgerEntryId, ledgerId);
});

test('completed duplicate deposit is idempotent and does not credit wallet again', async () => {
  const { db, calls } = createPipelineDb({
    existingDeposit: {
      id: depositId,
      userId,
      externalDepositId: 'chain-tx-1',
      providerEventId: 'event-1',
      amount: '3',
      currency: 'XAN',
      status: 'COMPLETED',
      creditedLedgerEntryId: ledgerId,
      completedAt: new Date(),
    },
  });

  const result = await processVerifiedDeposit(db, {
    userId,
    externalTransactionId: 'chain-tx-1',
    providerEventId: 'event-1',
    amount: '3',
    currency: 'XAN',
    verified: true,
  });

  assert.equal(result.idempotent, true);
  assert.equal(result.ledger, null);
  assert.deepEqual(calls.map(([name]) => name), ['lockDeposit']);
});

test('worker restart after pending deposit resumes processing without creating a second deposit row', async () => {
  const { db, calls } = createPipelineDb({
    existingDeposit: {
      id: depositId,
      userId,
      externalDepositId: 'chain-tx-1',
      providerEventId: 'event-1',
      amount: '3',
      currency: 'XAN',
      status: 'PENDING',
      creditedLedgerEntryId: null,
      completedAt: null,
    },
  });

  const result = await processVerifiedDeposit(db, {
    userId,
    externalTransactionId: 'chain-tx-1',
    providerEventId: 'event-1',
    amount: '3',
    currency: 'XAN',
    verified: true,
  });

  assert.equal(result.idempotent, false);
  assert.equal(result.deposit.status, 'COMPLETED');
  assert.equal(calls.some(([name]) => name === 'createDeposit'), false);
  assert.equal(calls.filter(([name]) => name === 'ledger').length, 1);
});

test('unique race resolved after restart returns completed duplicate without second credit', async () => {
  const { db } = createPipelineDb({
    failCreateWithUnique: true,
    duplicateLookupDeposit: {
      id: depositId,
      userId,
      externalDepositId: 'chain-tx-1',
      providerEventId: 'event-1',
      amount: '3',
      currency: 'XAN',
      status: 'COMPLETED',
      creditedLedgerEntryId: ledgerId,
      completedAt: new Date(),
    },
  });

  const result = await processVerifiedDeposit(db, {
    userId,
    externalTransactionId: 'chain-tx-1',
    providerEventId: 'event-1',
    amount: '3',
    currency: 'XAN',
    verified: true,
  });

  assert.equal(result.idempotent, true);
  assert.equal(result.ledger, null);
});

test('duplicate in-progress deposit does not attempt a second credit', async () => {
  const { db } = createPipelineDb({
    failCreateWithUnique: true,
    duplicateLookupDeposit: {
      id: depositId,
      userId,
      externalDepositId: 'chain-tx-1',
      providerEventId: 'event-1',
      amount: '3',
      currency: 'XAN',
      status: 'PENDING',
      creditedLedgerEntryId: null,
      completedAt: null,
    },
  });

  await assert.rejects(
    () => processVerifiedDeposit(db, {
      userId,
      externalTransactionId: 'chain-tx-1',
      providerEventId: 'event-1',
      amount: '3',
      currency: 'XAN',
      verified: true,
    }),
    (error) => error.code === 'DEPOSIT_DUPLICATE_IN_PROGRESS',
  );
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
