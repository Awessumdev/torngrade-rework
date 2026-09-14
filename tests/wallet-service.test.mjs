import assert from 'node:assert/strict';
import {
  LEDGER_DIRECTIONS,
  LEDGER_ENTRY_TYPES,
  WalletError,
  creditDeposit,
  debitBetStake,
  markWithdrawalPaid,
  moneyToString,
  parseMoney,
  refundWithdrawal,
  requestWithdrawal,
} from '../src/wallet/wallet-service.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const baseWallet = {
  id: 'wallet-1',
  userId: '00000000-0000-0000-0000-000000000001',
  currency: 'XAN',
  availableBalance: '10',
  pendingWithdrawal: '0',
  status: 'ACTIVE',
};

function createDb(wallet = baseWallet) {
  const calls = [];
  const tx = {
    $queryRaw: async () => {
      calls.push(['lockWallet']);
      return [wallet];
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
      update: async ({ where, data }) => {
        calls.push(['walletUpdate', { where, data }]);
        wallet.availableBalance = data.availableBalance ?? wallet.availableBalance;
        wallet.pendingWithdrawal = data.pendingWithdrawal ?? wallet.pendingWithdrawal;
        return { ...wallet, version: 1 };
      },
    },
  };

  return {
    calls,
    db: {
      $transaction: async (fn) => fn(tx),
    },
  };
}

test('money helpers preserve 18 decimal precision', () => {
  assert.equal(parseMoney('1.000000000000000001'), 1000000000000000001n);
  assert.equal(moneyToString(1000000000000000001n), '1.000000000000000001');
  assert.throws(() => parseMoney('0'), (error) => error.code === 'INVALID_AMOUNT');
});

test('deposit credits available balance and creates immutable ledger intent', async () => {
  const { db, calls } = createDb({ ...baseWallet, availableBalance: '2' });

  const result = await creditDeposit(db, {
    userId: baseWallet.userId,
    amount: '3.5',
    depositId: '10000000-0000-0000-0000-000000000001',
    idempotencyKey: 'deposit:1',
  });

  assert.equal(result.wallet.availableBalance, '5.5');
  assert.deepEqual(calls.map(([name]) => name), ['lockWallet', 'allowWalletMutation', 'ledger', 'walletUpdate']);
  assert.equal(calls[2][1].type, LEDGER_ENTRY_TYPES.DEPOSIT);
  assert.equal(calls[2][1].direction, LEDGER_DIRECTIONS.CREDIT);
  assert.equal(calls[2][1].balanceBefore, '2');
  assert.equal(calls[2][1].balanceAfter, '5.5');
});

test('bet stake debits available balance inside wallet transaction', async () => {
  const { db, calls } = createDb({ ...baseWallet, availableBalance: '10' });

  const result = await debitBetStake(db, {
    userId: baseWallet.userId,
    amount: '1',
    betId: '20000000-0000-0000-0000-000000000001',
    idempotencyKey: 'bet:1',
  });

  assert.equal(result.wallet.availableBalance, '9');
  assert.equal(calls[2][1].type, LEDGER_ENTRY_TYPES.BET_STAKE);
  assert.equal(calls[2][1].direction, LEDGER_DIRECTIONS.DEBIT);
});

test('insufficient funds fails before ledger and wallet update', async () => {
  const { db, calls } = createDb({ ...baseWallet, availableBalance: '0.5' });

  await assert.rejects(
    () => debitBetStake(db, {
      userId: baseWallet.userId,
      amount: '1',
      betId: '20000000-0000-0000-0000-000000000002',
    }),
    (error) => error instanceof WalletError && error.code === 'INSUFFICIENT_FUNDS',
  );

  assert.deepEqual(calls.map(([name]) => name), ['lockWallet', 'allowWalletMutation']);
});

test('withdrawal request moves available balance into pendingWithdrawal', async () => {
  const { db, calls } = createDb({ ...baseWallet, availableBalance: '10', pendingWithdrawal: '2' });

  const result = await requestWithdrawal(db, {
    userId: baseWallet.userId,
    amount: '3',
    withdrawalId: '30000000-0000-0000-0000-000000000001',
    idempotencyKey: 'withdrawal:1',
  });

  assert.equal(result.wallet.availableBalance, '7');
  assert.equal(result.wallet.pendingWithdrawal, '5');
  assert.equal(calls[2][1].type, LEDGER_ENTRY_TYPES.WITHDRAWAL_REQUEST);
});

test('withdrawal refund restores available balance and reduces pendingWithdrawal', async () => {
  const { db } = createDb({ ...baseWallet, availableBalance: '7', pendingWithdrawal: '3' });

  const result = await refundWithdrawal(db, {
    userId: baseWallet.userId,
    amount: '3',
    withdrawalId: '30000000-0000-0000-0000-000000000001',
    idempotencyKey: 'withdrawal-refund:1',
  });

  assert.equal(result.wallet.availableBalance, '10');
  assert.equal(result.wallet.pendingWithdrawal, '0');
  assert.equal(result.ledger.type, LEDGER_ENTRY_TYPES.WITHDRAWAL_REFUND);
});

test('withdrawal paid clears pendingWithdrawal without debiting available twice', async () => {
  const { db } = createDb({ ...baseWallet, availableBalance: '7', pendingWithdrawal: '3' });

  const result = await markWithdrawalPaid(db, {
    userId: baseWallet.userId,
    amount: '3',
    withdrawalId: '30000000-0000-0000-0000-000000000001',
    idempotencyKey: 'withdrawal-paid:1',
  });

  assert.equal(result.wallet.availableBalance, '7');
  assert.equal(result.wallet.pendingWithdrawal, '0');
  assert.equal(result.ledger.type, LEDGER_ENTRY_TYPES.WITHDRAWAL_PAID);
  assert.equal(result.ledger.balanceBefore, '7');
  assert.equal(result.ledger.balanceAfter, '7');
});

test('integration: serialized wallet lock prevents concurrent double spend', async () => {
  let storedWallet = { ...baseWallet, availableBalance: '1', pendingWithdrawal: '0' };
  let lock = Promise.resolve();
  const ledgerEntries = [];

  const db = {
    $transaction: async (fn) => {
      const previous = lock;
      let release;
      lock = new Promise((resolve) => {
        release = resolve;
      });
      await previous;

      const tx = {
        $queryRaw: async () => [{ ...storedWallet }],
        $executeRaw: async () => 1,
        ledgerEntry: {
          create: async ({ data }) => {
            ledgerEntries.push(data);
            return { id: `ledger-${ledgerEntries.length}`, ...data };
          },
        },
        wallet: {
          update: async ({ data }) => {
            storedWallet = {
              ...storedWallet,
              availableBalance: data.availableBalance,
              pendingWithdrawal: data.pendingWithdrawal ?? storedWallet.pendingWithdrawal,
            };
            return { ...storedWallet };
          },
        },
      };

      try {
        return await fn(tx);
      } finally {
        release();
      }
    },
  };

  const first = debitBetStake(db, {
    userId: baseWallet.userId,
    amount: '1',
    betId: '20000000-0000-0000-0000-000000000101',
    idempotencyKey: 'bet:concurrent:1',
  });
  const second = debitBetStake(db, {
    userId: baseWallet.userId,
    amount: '1',
    betId: '20000000-0000-0000-0000-000000000102',
    idempotencyKey: 'bet:concurrent:2',
  });

  const results = await Promise.allSettled([first, second]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(storedWallet.availableBalance, '0');
  assert.equal(ledgerEntries.length, 1);
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
