import assert from 'node:assert/strict';
import {
  assertSettlementConfirmed,
  buildSettlementPreview,
  createSettlementPreview,
  initiateSettlementWithConfirmation,
  settleClosedMarketAtomically,
  voidMarketWithRefundsAtomically,
} from '../src/settlement/settlement-preview.mjs';
import { ADMIN_ROLES, ADMIN_STATUS } from '../src/auth/authorization.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const admin = {
  id: '00000000-0000-0000-0000-00000000a001',
  status: ADMIN_STATUS.ACTIVE,
  roles: [ADMIN_ROLES.MARKET_SETTLER],
};
const marketId = '00000000-0000-0000-0000-0000000000bb';
const winningOutcomeId = '00000000-0000-0000-0000-0000000000cc';
const losingOutcomeId = '00000000-0000-0000-0000-0000000000dd';

const closedMarket = {
  id: marketId,
  question: 'Will Trump say yes?',
  status: 'CLOSED',
  outcomes: [
    { id: winningOutcomeId, marketId, name: 'YES' },
    { id: losingOutcomeId, marketId, name: 'NO' },
  ],
};

const aggregate = {
  winningBetCount: 3,
  losingBetCount: 2,
  totalWinningStake: '3',
  totalPayout: '5.1',
  totalStake: '5',
};

test('builds CLOSED market settlement preview and confirmation screen values', () => {
  const preview = buildSettlementPreview({
    market: closedMarket,
    winningOutcome: closedMarket.outcomes[0],
    aggregate,
  });

  assert.deepEqual(preview, {
    market: {
      id: marketId,
      question: 'Will Trump say yes?',
      status: 'CLOSED',
    },
    winningOutcome: {
      id: winningOutcomeId,
      name: 'YES',
    },
    winningBetCount: 3,
    losingBetCount: 2,
    totalWinningStake: '3',
    totalPayout: '5.1',
    projectedPnL: '-0.1',
    currentSystemBalance: '0',
    requiredSettlementBalance: '5.1',
    settlementLiquiditySufficient: false,
    criticalWarning: 'INSUFFICIENT_SETTLEMENT_LIQUIDITY',
    confirmation: {
      marketId,
      winningOutcome: 'YES',
      totalPayout: '5.1',
      winningBets: 3,
    },
  });
});

test('preview rejects non-CLOSED market and outcome mismatch', () => {
  assert.throws(
    () => buildSettlementPreview({
      market: { ...closedMarket, status: 'OPEN' },
      winningOutcome: closedMarket.outcomes[0],
      aggregate,
    }),
    (error) => error.code === 'MARKET_NOT_CLOSED',
  );

  assert.throws(
    () => buildSettlementPreview({
      market: closedMarket,
      winningOutcome: { id: winningOutcomeId, marketId: losingOutcomeId, name: 'YES' },
      aggregate,
    }),
    (error) => error.code === 'WINNING_OUTCOME_MARKET_MISMATCH',
  );
});

test('loads settlement preview from stored accepted bet snapshots', async () => {
  const db = {
    market: {
      findUnique: async ({ where, include }) => {
        assert.equal(where.id, marketId);
        assert.deepEqual(include, { outcomes: true });
        return closedMarket;
      },
    },
    $queryRaw: async (strings) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('"Wallet"')) return [{ currentSystemBalance: '10' }];
      return [aggregate];
    },
  };

  const preview = await createSettlementPreview({ db, admin, marketId, winningOutcomeId });

  assert.equal(preview.winningOutcome.name, 'YES');
  assert.equal(preview.totalPayout, '5.1');
  assert.equal(preview.currentSystemBalance, '10');
  assert.equal(preview.settlementLiquiditySufficient, true);
  assert.equal(preview.confirmation.winningBets, 3);
});

test('requires explicit second confirmation before settlement initiation', () => {
  const preview = buildSettlementPreview({
    market: closedMarket,
    winningOutcome: closedMarket.outcomes[0],
    aggregate,
  });

  assert.throws(
    () => assertSettlementConfirmed({ preview, confirmation: null }),
    (error) => error.code === 'SETTLEMENT_CONFIRMATION_REQUIRED',
  );

  assert.throws(
    () => assertSettlementConfirmed({
      preview,
      confirmation: {
        confirmed: true,
        marketId,
        winningOutcomeId,
        totalPayout: '5.0',
        winningBetCount: 3,
      },
    }),
    (error) => error.code === 'SETTLEMENT_CONFIRMATION_MISMATCH',
  );

  assert.doesNotThrow(() => assertSettlementConfirmed({
    preview,
    confirmation: {
      confirmed: true,
      marketId,
      winningOutcomeId,
      totalPayout: '5.1',
      winningBetCount: 3,
    },
  }));
});

function createSettlementDb() {
  const calls = [];
  const marketRow = { id: marketId, question: closedMarket.question, status: 'CLOSED' };

  return {
    calls,
    db: {
      $transaction: async (fn) => fn({
        $queryRaw: async (strings) => {
          const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
          if (sql.includes('"Market"')) {
            calls.push(['lockMarket']);
            return [marketRow];
          }
          if (sql.includes('"Bet"')) {
            calls.push(['aggregateBets']);
            return [aggregate];
          }
          if (sql.includes('"Wallet"')) {
            calls.push(['loadSystemBalance']);
            return [{ currentSystemBalance: '10' }];
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
        outcome: {
          findFirst: async ({ where }) => {
            calls.push(['loadWinningOutcome', where]);
            return closedMarket.outcomes.find((outcome) => outcome.id === where.id && outcome.marketId === where.marketId);
          },
        },
        market: {
          update: async ({ where, data }) => {
            calls.push(['updateMarket', { where, data }]);
            return { ...marketRow, ...data };
          },
        },
        settlement: {
          findUnique: async () => null,
          update: async ({ data }) => {
            calls.push(['updateSettlement', data]);
            return { id: 'settlement-existing', marketId, ...data };
          },
          create: async ({ data }) => {
            calls.push(['createSettlement', data]);
            return { ...data };
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

test('settlement initiation refuses to start without matching confirmation', async () => {
  const { db, calls } = createSettlementDb();

  await assert.rejects(
    () => initiateSettlementWithConfirmation({
      db,
      admin,
      marketId,
      winningOutcomeId,
      confirmation: {
        confirmed: false,
        marketId,
        winningOutcomeId,
        totalPayout: '5.1',
        winningBetCount: 3,
      },
    }),
    (error) => error.code === 'SETTLEMENT_CONFIRMATION_REQUIRED',
  );

  assert.deepEqual(calls.map(([name]) => name), ['lockMarket', 'loadWinningOutcome', 'aggregateBets', 'loadSystemBalance']);
});

test('confirmed settlement sets market SETTLING, stores winning outcome, creates settlement and audit', async () => {
  const { db, calls } = createSettlementDb();

  const result = await initiateSettlementWithConfirmation({
    db,
    admin,
    marketId,
    winningOutcomeId,
    confirmation: {
      confirmed: true,
      marketId,
      winningOutcomeId,
      totalPayout: '5.1',
      winningBetCount: 3,
    },
  });

  assert.equal(result.market.status, 'SETTLING');
  assert.equal(result.market.winningOutcomeId, winningOutcomeId);
  assert.equal(result.settlement.marketId, marketId);
  assert.equal(result.settlement.winningOutcomeId, winningOutcomeId);
  assert.deepEqual(calls.map(([name]) => name), [
    'lockMarket',
    'loadWinningOutcome',
    'aggregateBets',
    'loadSystemBalance',
    'updateMarket',
    'createSettlement',
    'audit',
  ]);
  assert.equal(calls[4][1].data.status, 'SETTLING');
  assert.equal(calls[6][1].action, 'SETTLEMENT_INITIATED');
  assert.equal(calls[6][1].metadata.preview.confirmation.totalPayout, '5.1');
});

test('confirmed settlement is blocked when system liquidity is insufficient', async () => {
  const { db, calls } = createSettlementDb();
  const originalTransaction = db.$transaction;
  db.$transaction = async (fn) => originalTransaction(async (tx) => {
    const originalQuery = tx.$queryRaw;
    tx.$queryRaw = async (strings) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('"Wallet"')) {
        calls.push(['loadSystemBalance']);
        return [{ currentSystemBalance: '1' }];
      }
      return originalQuery(strings);
    };
    return fn(tx);
  });

  await assert.rejects(
    () => initiateSettlementWithConfirmation({
      db,
      admin,
      marketId,
      winningOutcomeId,
      confirmation: {
        confirmed: true,
        marketId,
        winningOutcomeId,
        totalPayout: '5.1',
        winningBetCount: 3,
      },
    }),
    (error) => error.code === 'INSUFFICIENT_SETTLEMENT_LIQUIDITY',
  );
  assert.equal(calls.some(([name]) => name === 'updateMarket'), false);
});

function createAtomicSettlementDb({ marketStatus = 'CLOSED' } = {}) {
  const calls = [];
  const wallets = new Map([
    ['00000000-0000-0000-0000-000000000101', {
      id: '00000000-0000-0000-0000-00000000w101',
      userId: '00000000-0000-0000-0000-000000000101',
      currency: 'XAN',
      availableBalance: '0',
      pendingWithdrawal: '0',
      status: 'ACTIVE',
    }],
    ['00000000-0000-0000-0000-000000000102', {
      id: '00000000-0000-0000-0000-00000000w102',
      userId: '00000000-0000-0000-0000-000000000102',
      currency: 'XAN',
      availableBalance: '1',
      pendingWithdrawal: '0',
      status: 'ACTIVE',
    }],
  ]);
  const winningBets = [
    {
      id: '00000000-0000-0000-0000-000000000201',
      userId: '00000000-0000-0000-0000-000000000101',
      marketId,
      outcomeId: winningOutcomeId,
      stake: '1',
      oddsSnapshot: '1.70',
      potentialPayout: '1.7',
      status: 'OPEN',
    },
    {
      id: '00000000-0000-0000-0000-000000000202',
      userId: '00000000-0000-0000-0000-000000000102',
      marketId,
      outcomeId: winningOutcomeId,
      stake: '1',
      oddsSnapshot: '1.55',
      potentialPayout: '1.55',
      status: 'OPEN',
    },
  ];
  const losingBets = [{
    id: '00000000-0000-0000-0000-000000000203',
    userId: '00000000-0000-0000-0000-000000000103',
    marketId,
    outcomeId: losingOutcomeId,
    stake: '1',
    oddsSnapshot: '2.05',
    potentialPayout: '2.05',
    status: 'OPEN',
  }];
  const market = { id: marketId, question: closedMarket.question, status: marketStatus };

  return {
    calls,
    wallets,
    db: {
      $transaction: async (fn) => fn({
        $queryRaw: async (strings, value) => {
          const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
          if (sql.includes('FROM "Market"')) {
            calls.push(['lockMarket']);
            return [market];
          }
          if (sql.includes('FROM "Bet"') && sql.includes('"outcomeId" =')) {
            calls.push(['findWinningBets']);
            return winningBets;
          }
          if (sql.includes('FROM "Bet"') && sql.includes('"outcomeId" <>')) {
            calls.push(['findLosingBets']);
            return losingBets;
          }
          if (sql.includes('FROM "Wallet"')) {
            calls.push(['lockWallet']);
            return [wallets.get(String(value))];
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
        $executeRaw: async () => {
          calls.push(['allowWalletMutation']);
          return 1;
        },
        outcome: {
          findFirst: async ({ where }) => {
            calls.push(['loadWinningOutcome', where]);
            return closedMarket.outcomes.find((outcome) => outcome.id === where.id && outcome.marketId === where.marketId);
          },
        },
        market: {
          update: async ({ data }) => {
            calls.push(['updateMarket', data]);
            Object.assign(market, data);
            return { ...market };
          },
        },
        ledgerEntry: {
          create: async ({ data }) => {
            calls.push(['ledger', data]);
            return { id: `ledger-${calls.filter(([name]) => name === 'ledger').length}`, ...data };
          },
        },
        wallet: {
          update: async ({ where, data }) => {
            calls.push(['walletUpdate', { where, data }]);
            const wallet = [...wallets.values()].find((item) => item.id === where.id);
            wallet.availableBalance = data.availableBalance;
            return { ...wallet };
          },
        },
        bet: {
          updateMany: async ({ where, data }) => {
            calls.push(['updateBets', { where, data }]);
            return { count: where.id.in.length };
          },
        },
        settlement: {
          create: async ({ data }) => {
            calls.push(['createSettlement', data]);
            return { ...data };
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

test('atomic settlement credits winners from accepted payout snapshots, marks bets, settles market, and audits', async () => {
  const { db, calls, wallets } = createAtomicSettlementDb();
  const settledAt = new Date('2026-09-13T13:00:00.000Z');

  const result = await settleClosedMarketAtomically({
    db,
    admin,
    marketId,
    winningOutcomeId,
    now: settledAt,
  });

  assert.equal(result.idempotent, false);
  assert.equal(result.market.status, 'SETTLED');
  assert.equal(result.paidWinningBetCount, 2);
  assert.equal(result.lostBetCount, 1);
  assert.equal(result.totalPayout, '3.25');
  assert.equal(wallets.get('00000000-0000-0000-0000-000000000101').availableBalance, '1.7');
  assert.equal(wallets.get('00000000-0000-0000-0000-000000000102').availableBalance, '2.55');
  assert.equal(calls.filter(([name]) => name === 'ledger').length, 2);
  assert.equal(calls.find(([name]) => name === 'ledger')[1].type, 'BET_WIN');
  assert.equal(calls.some(([name, data]) => name === 'ledger' && data.metadata.oddsSnapshot === '9.99'), false);
  assert.deepEqual(calls.map(([name]) => name), [
    'lockMarket',
    'loadWinningOutcome',
    'updateMarket',
    'findWinningBets',
    'findLosingBets',
    'allowWalletMutation',
    'lockWallet',
    'ledger',
    'walletUpdate',
    'lockWallet',
    'ledger',
    'walletUpdate',
    'updateBets',
    'updateBets',
    'createSettlement',
    'updateMarket',
    'audit',
  ]);
});

test('settling an already SETTLED market is idempotent and does not credit balances again', async () => {
  const { db, calls, wallets } = createAtomicSettlementDb({ marketStatus: 'SETTLED' });

  const result = await settleClosedMarketAtomically({
    db,
    admin,
    marketId,
    winningOutcomeId,
  });

  assert.equal(result.idempotent, true);
  assert.equal(wallets.get('00000000-0000-0000-0000-000000000101').availableBalance, '0');
  assert.deepEqual(calls.map(([name]) => name), ['lockMarket']);
});

test('SETTLING market can resume settlement with the same winning outcome', async () => {
  const { db, calls } = createAtomicSettlementDb({ marketStatus: 'SETTLING' });

  const result = await settleClosedMarketAtomically({
    db,
    admin,
    marketId,
    winningOutcomeId,
  });

  assert.equal(result.idempotent, false);
  assert.equal(result.market.status, 'SETTLED');
  assert.equal(calls.some(([name]) => name === 'createSettlement'), true);
  assert.equal(calls.filter(([name]) => name === 'ledger').length, 2);
});

test('concurrent duplicate settlement only credits once after market lock serializes requests', async () => {
  let marketStatus = 'CLOSED';
  let lock = Promise.resolve();
  const ledgerEntries = [];

  function dbFactory() {
    const wallets = new Map([['00000000-0000-0000-0000-000000000101', {
      id: '00000000-0000-0000-0000-00000000w101',
      userId: '00000000-0000-0000-0000-000000000101',
      currency: 'XAN',
      availableBalance: '0',
      pendingWithdrawal: '0',
      status: 'ACTIVE',
    }]]);

    return {
      $transaction: async (fn) => {
        const previous = lock;
        let release;
        lock = new Promise((resolve) => {
          release = resolve;
        });
        await previous;

        const tx = {
          $queryRaw: async (strings, value) => {
            const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
            if (sql.includes('FROM "Market"')) return [{ id: marketId, status: marketStatus }];
            if (sql.includes('FROM "Bet"') && sql.includes('"outcomeId" =')) {
              return ledgerEntries.length === 0 ? [{
                id: '00000000-0000-0000-0000-000000000201',
                userId: '00000000-0000-0000-0000-000000000101',
                marketId,
                outcomeId: winningOutcomeId,
                stake: '1',
                oddsSnapshot: '1.70',
                potentialPayout: '1.7',
                status: 'OPEN',
              }] : [];
            }
            if (sql.includes('FROM "Bet"') && sql.includes('"outcomeId" <>')) return [];
            if (sql.includes('FROM "Wallet"')) return [wallets.get(String(value))];
            return [];
          },
          $executeRaw: async () => 1,
          outcome: { findFirst: async () => closedMarket.outcomes[0] },
          market: {
            update: async ({ data }) => {
              marketStatus = data.status;
              return { id: marketId, ...data };
            },
          },
          ledgerEntry: {
            create: async ({ data }) => {
              ledgerEntries.push(data);
              return { id: `ledger-${ledgerEntries.length}`, ...data };
            },
          },
          wallet: {
            update: async ({ where, data }) => {
              const wallet = [...wallets.values()].find((item) => item.id === where.id);
              wallet.availableBalance = data.availableBalance;
              return { ...wallet };
            },
          },
          bet: { updateMany: async () => ({ count: 1 }) },
          settlement: { create: async ({ data }) => data },
          auditLog: { create: async ({ data }) => data },
        };

        try {
          return await fn(tx);
        } finally {
          release();
        }
      },
    };
  }

  const first = settleClosedMarketAtomically({ db: dbFactory(), admin, marketId, winningOutcomeId });
  const second = settleClosedMarketAtomically({ db: dbFactory(), admin, marketId, winningOutcomeId });
  const results = await Promise.allSettled([first, second]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  assert.equal(results.filter((result) => result.value?.idempotent === false).length, 1);
  assert.equal(results.filter((result) => result.value?.idempotent === true).length, 1);
  assert.equal(ledgerEntries.length, 1);
});

function createVoidDb({ marketStatus = 'OPEN' } = {}) {
  const calls = [];
  const wallets = new Map([
    ['00000000-0000-0000-0000-000000000101', {
      id: '00000000-0000-0000-0000-00000000w101',
      userId: '00000000-0000-0000-0000-000000000101',
      currency: 'XAN',
      availableBalance: '0',
      pendingWithdrawal: '0',
      status: 'ACTIVE',
    }],
    ['00000000-0000-0000-0000-000000000102', {
      id: '00000000-0000-0000-0000-00000000w102',
      userId: '00000000-0000-0000-0000-000000000102',
      currency: 'XAN',
      availableBalance: '5',
      pendingWithdrawal: '0',
      status: 'ACTIVE',
    }],
  ]);
  const openBets = [
    {
      id: '00000000-0000-0000-0000-000000000301',
      userId: '00000000-0000-0000-0000-000000000101',
      marketId,
      outcomeId: winningOutcomeId,
      stake: '1',
      oddsSnapshot: '99.99',
      potentialPayout: '99.99',
      status: 'OPEN',
    },
    {
      id: '00000000-0000-0000-0000-000000000302',
      userId: '00000000-0000-0000-0000-000000000102',
      marketId,
      outcomeId: losingOutcomeId,
      stake: '1',
      oddsSnapshot: '2.05',
      potentialPayout: '2.05',
      status: 'OPEN',
    },
  ];
  const market = { id: marketId, question: closedMarket.question, status: marketStatus };

  return {
    calls,
    wallets,
    db: {
      $transaction: async (fn) => fn({
        $queryRaw: async (strings, value) => {
          const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
          if (sql.includes('FROM "Market"')) {
            calls.push(['lockMarket']);
            return [market];
          }
          if (sql.includes('FROM "Bet"')) {
            calls.push(['findOpenBets']);
            return openBets;
          }
          if (sql.includes('FROM "Wallet"')) {
            calls.push(['lockWallet']);
            return [wallets.get(String(value))];
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
            return { id: `ledger-${calls.filter(([name]) => name === 'ledger').length}`, ...data };
          },
        },
        wallet: {
          update: async ({ where, data }) => {
            calls.push(['walletUpdate', { where, data }]);
            const wallet = [...wallets.values()].find((item) => item.id === where.id);
            wallet.availableBalance = data.availableBalance;
            return { ...wallet };
          },
        },
        bet: {
          updateMany: async ({ where, data }) => {
            calls.push(['updateBets', { where, data }]);
            return { count: where.id.in.length };
          },
        },
        market: {
          update: async ({ data }) => {
            calls.push(['updateMarket', data]);
            Object.assign(market, data);
            return { ...market };
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

test('void market refunds original stake only, marks bets VOID, marks market VOID, and audits', async () => {
  const { db, calls, wallets } = createVoidDb({ marketStatus: 'OPEN' });
  const voidedAt = new Date('2026-09-13T14:00:00.000Z');

  const result = await voidMarketWithRefundsAtomically({
    db,
    admin,
    marketId,
    reason: 'event cancelled',
    now: voidedAt,
  });

  assert.equal(result.idempotent, false);
  assert.equal(result.refundedBetCount, 2);
  assert.equal(result.totalRefund, '2');
  assert.equal(wallets.get('00000000-0000-0000-0000-000000000101').availableBalance, '1');
  assert.equal(wallets.get('00000000-0000-0000-0000-000000000102').availableBalance, '6');
  assert.equal(calls.filter(([name]) => name === 'ledger').length, 2);
  assert.equal(calls.find(([name]) => name === 'ledger')[1].type, 'BET_VOID_REFUND');
  assert.equal(calls.find(([name]) => name === 'ledger')[1].amount, '1');
  assert.equal(calls.some(([name, data]) => name === 'ledger' && data.amount === '99.99'), false);
  assert.equal(result.market.status, 'VOID');
  assert.deepEqual(calls.map(([name]) => name), [
    'lockMarket',
    'findOpenBets',
    'allowWalletMutation',
    'lockWallet',
    'ledger',
    'walletUpdate',
    'lockWallet',
    'ledger',
    'walletUpdate',
    'updateBets',
    'updateMarket',
    'audit',
  ]);
});

test('already VOID market is idempotent and does not refund twice', async () => {
  const { db, calls, wallets } = createVoidDb({ marketStatus: 'VOID' });

  const result = await voidMarketWithRefundsAtomically({ db, admin, marketId });

  assert.equal(result.idempotent, true);
  assert.equal(result.totalRefund, '0');
  assert.equal(wallets.get('00000000-0000-0000-0000-000000000101').availableBalance, '0');
  assert.deepEqual(calls.map(([name]) => name), ['lockMarket']);
});

test('non-eligible SETTLED market cannot be voided', async () => {
  const { db, calls } = createVoidDb({ marketStatus: 'SETTLED' });

  await assert.rejects(
    () => voidMarketWithRefundsAtomically({ db, admin, marketId }),
    (error) => error.code === 'MARKET_NOT_VOIDABLE',
  );

  assert.deepEqual(calls.map(([name]) => name), ['lockMarket']);
});

test('concurrent duplicate void only refunds once after market lock serializes requests', async () => {
  let marketStatus = 'OPEN';
  let lock = Promise.resolve();
  const ledgerEntries = [];

  function dbFactory() {
    const wallets = new Map([['00000000-0000-0000-0000-000000000101', {
      id: '00000000-0000-0000-0000-00000000w101',
      userId: '00000000-0000-0000-0000-000000000101',
      currency: 'XAN',
      availableBalance: '0',
      pendingWithdrawal: '0',
      status: 'ACTIVE',
    }]]);

    return {
      $transaction: async (fn) => {
        const previous = lock;
        let release;
        lock = new Promise((resolve) => {
          release = resolve;
        });
        await previous;

        const tx = {
          $queryRaw: async (strings, value) => {
            const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
            if (sql.includes('FROM "Market"')) return [{ id: marketId, status: marketStatus }];
            if (sql.includes('FROM "Bet"')) {
              return ledgerEntries.length === 0 ? [{
                id: '00000000-0000-0000-0000-000000000301',
                userId: '00000000-0000-0000-0000-000000000101',
                marketId,
                outcomeId: winningOutcomeId,
                stake: '1',
                oddsSnapshot: '9.99',
                potentialPayout: '9.99',
                status: 'OPEN',
              }] : [];
            }
            if (sql.includes('FROM "Wallet"')) return [wallets.get(String(value))];
            return [];
          },
          $executeRaw: async () => 1,
          ledgerEntry: {
            create: async ({ data }) => {
              ledgerEntries.push(data);
              return { id: `ledger-${ledgerEntries.length}`, ...data };
            },
          },
          wallet: {
            update: async ({ where, data }) => {
              const wallet = [...wallets.values()].find((item) => item.id === where.id);
              wallet.availableBalance = data.availableBalance;
              return { ...wallet };
            },
          },
          bet: { updateMany: async () => ({ count: 1 }) },
          market: {
            update: async ({ data }) => {
              marketStatus = data.status;
              return { id: marketId, ...data };
            },
          },
          auditLog: { create: async ({ data }) => data },
        };

        try {
          return await fn(tx);
        } finally {
          release();
        }
      },
    };
  }

  const first = voidMarketWithRefundsAtomically({ db: dbFactory(), admin, marketId });
  const second = voidMarketWithRefundsAtomically({ db: dbFactory(), admin, marketId });
  const results = await Promise.allSettled([first, second]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  assert.equal(results.filter((result) => result.value?.idempotent === false).length, 1);
  assert.equal(results.filter((result) => result.value?.idempotent === true).length, 1);
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntries[0].amount, '1');
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
