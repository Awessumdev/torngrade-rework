import assert from 'node:assert/strict';
import {
  BET_LIMITS,
  calculatePotentialPayout,
  normalizeBetRequest,
  placeBet,
  validateMarketLiability,
  buildMarketRiskSummary,
} from '../src/betting/bet-service.mjs';
import { USER_STATUS, WHITELIST_STATUS } from '../src/auth/authorization.mjs';
import { GLOBAL_BETTING_STATUS } from '../src/system/system-config.mjs';
import { LEDGER_ENTRY_TYPES } from '../src/wallet/wallet-service.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const user = {
  id: '00000000-0000-0000-0000-000000000001',
  status: USER_STATUS.ACTIVE,
  whitelistEntries: [{ status: WHITELIST_STATUS.ACTIVE }],
};
const walletId = '00000000-0000-0000-0000-0000000000aa';
const marketId = '00000000-0000-0000-0000-0000000000bb';
const outcomeId = '00000000-0000-0000-0000-0000000000cc';
const eventId = '00000000-0000-0000-0000-0000000000ee';
const now = new Date('2026-09-13T12:00:00.000Z');

function createBetDb({
  availableBalance = '5',
  marketStatus = 'OPEN',
  outcomeStatus = 'ACTIVE',
  closesAt = '2026-09-13T12:05:00.000Z',
  odds = '1.70',
  liabilityRows = [],
  userOpenStake = '0',
  globalBettingStatus = GLOBAL_BETTING_STATUS.ACTIVE,
} = {}) {
  const calls = [];
  let wallet = {
    id: walletId,
    userId: user.id,
    currency: 'XAN',
    availableBalance,
    pendingWithdrawal: '0',
    status: 'ACTIVE',
  };

  const tx = {
    $queryRaw: async (strings) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('"Wallet"')) {
        calls.push(['lockWallet']);
        return [{ ...wallet }];
      }
      if (sql.includes('"SystemConfig"')) {
        calls.push(['lockSystemConfig']);
        return [{
          key: 'production',
          globalBettingStatus,
          betLimits: {
            minBet: '1',
            maxBet: '5',
            maxPayoutPerBet: '25',
            maxMarketLiability: '100',
            maxUserOpenExposure: '25',
          },
        }];
      }
      if (sql.includes('FROM "Outcome"')) {
        calls.push(['loadOutcome']);
        return [{
          outcomeId,
          marketId,
          odds,
          outcomeStatus,
          eventId,
          marketStatus,
          closesAt,
        }];
      }
      if (sql.includes('FROM "Bet"')) {
        if (sql.includes('"userId"')) {
          calls.push(['loadUserExposure']);
          return [{ totalOpenStake: userOpenStake }];
        }
        calls.push(['loadLiability']);
        return liabilityRows;
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    $executeRaw: async (strings) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('pg_advisory_xact_lock')) {
        calls.push(['lockMarketLiability']);
      } else {
        calls.push(['allowWalletMutation']);
      }
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
        wallet = {
          ...wallet,
          availableBalance: data.availableBalance,
          pendingWithdrawal: data.pendingWithdrawal ?? wallet.pendingWithdrawal,
        };
        return { ...wallet };
      },
    },
    bet: {
      create: async ({ data }) => {
        calls.push(['betCreate', data]);
        return { ...data, placedAt: now };
      },
      updateMany: async () => {
        calls.push(['FORBIDDEN_BET_SNAPSHOT_UPDATE']);
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

test('client can only send marketId, outcomeId, and stake', () => {
  assert.deepEqual(
    normalizeBetRequest({
      marketId,
      outcomeId,
      stake: '1.0000',
    }),
    { marketId, outcomeId, stake: '1' },
  );

  assert.throws(
    () => normalizeBetRequest({ marketId, outcomeId, stake: '1', idempotencyKey: 'bet:1' }),
    (error) => error.code === 'CLIENT_FIELD_NOT_ALLOWED',
  );
});

test('calculates potential payout from server-side current odds', () => {
  assert.equal(calculatePotentialPayout('1', '1.70'), '1.7');
  assert.equal(calculatePotentialPayout('1', '1.55'), '1.55');
});

test('validates projected market liability limit', () => {
  const lowTestLimits = { ...BET_LIMITS, maxMarketLiability: '10' };
  assert.doesNotThrow(() => validateMarketLiability({
    currentOutcomePayouts: [{ outcomeId, totalPotentialPayout: '8.3' }],
    outcomeId,
    newPotentialPayout: '1.7',
    limits: lowTestLimits,
  }));

  assert.throws(
    () => validateMarketLiability({
      currentOutcomePayouts: [{ outcomeId, totalPotentialPayout: '8.31' }],
      outcomeId,
      newPotentialPayout: '1.7',
      limits: lowTestLimits,
    }),
    (error) => error.code === 'MARKET_LIABILITY_LIMIT_EXCEEDED',
  );
});

test('builds per-outcome admin risk and projected P&L summary', () => {
  const summary = buildMarketRiskSummary({
    market: {
      id: marketId,
      question: 'Will Trump say yes?',
      status: 'OPEN',
      outcomes: [
        { id: outcomeId, name: 'YES', sortOrder: 1 },
        { id: '00000000-0000-0000-0000-0000000000dd', name: 'NO', sortOrder: 2 },
      ],
    },
    outcomeRiskRows: [
      { outcomeId, betCount: 3, totalStake: '3', totalPotentialPayout: '5.1' },
      { outcomeId: '00000000-0000-0000-0000-0000000000dd', betCount: 2, totalStake: '2', totalPotentialPayout: '4.1' },
    ],
  });

  assert.deepEqual(summary.outcomes, [
    {
      outcomeId,
      name: 'YES',
      betCount: 3,
      totalStake: '3',
      totalPotentialPayout: '5.1',
      netPnLIfOutcomeWins: '-0.1',
    },
    {
      outcomeId: '00000000-0000-0000-0000-0000000000dd',
      name: 'NO',
      betCount: 2,
      totalStake: '2',
      totalPotentialPayout: '4.1',
      netPnLIfOutcomeWins: '0.9',
    },
  ]);
});

test('places bet by locking wallet, validating server odds, debiting stake, writing ledger, then creating immutable bet snapshot', async () => {
  const { db, calls } = createBetDb();

  const result = await placeBet({
    db,
    user,
    request: { marketId, outcomeId, stake: '1' },
    now,
  });

  assert.equal(result.bet.stake, '1');
  assert.equal(result.bet.oddsSnapshot, '1.7');
  assert.equal(result.bet.potentialPayout, '1.7');
  assert.equal(result.wallet.availableBalance, '4');
  assert.deepEqual(calls.map(([name]) => name), [
    'lockSystemConfig',
    'lockWallet',
    'loadOutcome',
    'lockMarketLiability',
    'loadLiability',
    'loadUserExposure',
    'allowWalletMutation',
    'ledger',
    'walletUpdate',
    'betCreate',
  ]);
  assert.equal(calls[7][1].type, LEDGER_ENTRY_TYPES.BET_STAKE);
  assert.equal(calls[7][1].referenceId, calls[9][1].id);
  assert.equal(calls[9][1].oddsSnapshot, '1.7');
  assert.equal(calls[9][1].potentialPayout, '1.7');
});

test('does not mutate accepted bet snapshots when current odds later changes', async () => {
  const { db, calls } = createBetDb({ odds: '1.55' });

  const result = await placeBet({
    db,
    user,
    request: { marketId, outcomeId, stake: '1' },
    now,
  });

  assert.equal(result.bet.oddsSnapshot, '1.55');
  assert.equal(calls.some(([name]) => name === 'FORBIDDEN_BET_SNAPSHOT_UPDATE'), false);
});

test('rejects inactive users before transaction', async () => {
  const { db, calls } = createBetDb();

  await assert.rejects(
    () => placeBet({
      db,
      user: { id: user.id, status: USER_STATUS.SUSPENDED, whitelistEntries: [] },
      request: { marketId, outcomeId, stake: '1' },
      now,
    }),
    (error) => error.code === 'USER_NOT_ACTIVE',
  );

  assert.deepEqual(calls, []);
});

test('rejects globally suspended betting before wallet or market mutation', async () => {
  const { db, calls } = createBetDb({ globalBettingStatus: GLOBAL_BETTING_STATUS.SUSPENDED });

  await assert.rejects(
    () => placeBet({ db, user, request: { marketId, outcomeId, stake: '1' }, now }),
    (error) => error.code === 'GLOBAL_BETTING_SUSPENDED',
  );

  assert.deepEqual(calls.map(([name]) => name), ['lockSystemConfig']);
});

test('rejects insufficient wallet balance before market/risk work', async () => {
  const { db, calls } = createBetDb({ availableBalance: '0.5' });

  await assert.rejects(
    () => placeBet({ db, user, request: { marketId, outcomeId, stake: '1' }, now }),
    (error) => error.code === 'INSUFFICIENT_FUNDS',
  );

  assert.deepEqual(calls.map(([name]) => name), ['lockSystemConfig', 'lockWallet']);
});

test('rejects closed market, expired market, inactive outcome, stake limits, payout limit, liability limit, and user exposure limit', async () => {
  await assert.rejects(
    () => placeBet({ db: createBetDb({ marketStatus: 'SUSPENDED' }).db, user, request: { marketId, outcomeId, stake: '1' }, now }),
    (error) => error.code === 'MARKET_NOT_OPEN',
  );

  for (const blockedStatus of ['CLOSED', 'SETTLED', 'VOID']) {
    await assert.rejects(
      () => placeBet({ db: createBetDb({ marketStatus: blockedStatus }).db, user, request: { marketId, outcomeId, stake: '1' }, now }),
      (error) => error.code === 'MARKET_NOT_OPEN',
    );
  }

  await assert.rejects(
    () => placeBet({ db: createBetDb({ closesAt: '2026-09-13T11:59:59.000Z' }).db, user, request: { marketId, outcomeId, stake: '1' }, now }),
    (error) => error.code === 'MARKET_CLOSED_BY_TIME',
  );

  await assert.rejects(
    () => placeBet({ db: createBetDb({ outcomeStatus: 'SUSPENDED' }).db, user, request: { marketId, outcomeId, stake: '1' }, now }),
    (error) => error.code === 'OUTCOME_NOT_ACTIVE',
  );

  await assert.rejects(
    () => placeBet({ db: createBetDb().db, user, request: { marketId, outcomeId, stake: '0.5' }, now }),
    (error) => error.code === 'STAKE_BELOW_MIN',
  );

  await assert.doesNotReject(
    () => placeBet({ db: createBetDb().db, user, request: { marketId, outcomeId, stake: '2' }, now }),
  );

  await assert.rejects(
    () => placeBet({ db: createBetDb({ odds: '30.00' }).db, user, request: { marketId, outcomeId, stake: '1' }, now }),
    (error) => error.code === 'PAYOUT_ABOVE_MAX',
  );

  await assert.rejects(
    () => placeBet({
      db: createBetDb({ liabilityRows: [{ outcomeId, totalPotentialPayout: '99' }] }).db,
      user,
      request: { marketId, outcomeId, stake: '1' },
      now,
    }),
    (error) => error.code === 'MARKET_LIABILITY_LIMIT_EXCEEDED',
  );

  await assert.rejects(
    () => placeBet({
      db: createBetDb({ userOpenStake: '25' }).db,
      user,
      request: { marketId, outcomeId, stake: '1' },
      now,
    }),
    (error) => error.code === 'USER_OPEN_EXPOSURE_LIMIT_EXCEEDED',
  );
});

test('integration: serialized wallet transaction prevents concurrent double spending', async () => {
  let storedWallet = {
    id: walletId,
    userId: user.id,
    currency: 'XAN',
    availableBalance: '1',
    pendingWithdrawal: '0',
    status: 'ACTIVE',
  };
  let lock = Promise.resolve();
  const ledgers = [];
  const bets = [];

  const db = {
    $transaction: async (fn) => {
      const previous = lock;
      let release;
      lock = new Promise((resolve) => {
        release = resolve;
      });
      await previous;

      const tx = {
        $queryRaw: async (strings) => {
          const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
          if (sql.includes('"SystemConfig"')) {
            return [{
              globalBettingStatus: 'ACTIVE',
              betLimits: {
                minBet: '1',
                maxBet: '5',
                maxPayoutPerBet: '25',
                maxMarketLiability: '100',
                maxUserOpenExposure: '25',
              },
            }];
          }
          if (sql.includes('"Wallet"')) return [{ ...storedWallet }];
          if (sql.includes('FROM "Outcome"')) {
            return [{
              outcomeId,
              marketId,
              odds: '1.70',
              outcomeStatus: 'ACTIVE',
              eventId,
              marketStatus: 'OPEN',
              closesAt: '2026-09-13T12:05:00.000Z',
            }];
          }
          if (sql.includes('FROM "Bet"') && sql.includes('"userId"')) return [{ totalOpenStake: '0' }];
          if (sql.includes('FROM "Bet"')) return [];
          return [];
        },
        $executeRaw: async () => 1,
        ledgerEntry: {
          create: async ({ data }) => {
            ledgers.push(data);
            return { id: `ledger-${ledgers.length}`, ...data };
          },
        },
        wallet: {
          update: async ({ data }) => {
            storedWallet = { ...storedWallet, availableBalance: data.availableBalance };
            return { ...storedWallet };
          },
        },
        bet: {
          create: async ({ data }) => {
            bets.push(data);
            return data;
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

  const first = placeBet({ db, user, request: { marketId, outcomeId, stake: '1' }, now });
  const second = placeBet({ db, user, request: { marketId, outcomeId, stake: '1' }, now });
  const results = await Promise.allSettled([first, second]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(storedWallet.availableBalance, '0');
  assert.equal(ledgers.length, 1);
  assert.equal(bets.length, 1);
});

test('integration: serialized market liability lock prevents concurrent liability overrun', async () => {
  let currentLiability = 98;
  let marketLock = Promise.resolve();
  const accepted = [];

  function liabilityDb() {
    return {
      $transaction: async (fn) => {
        const tx = {
          $queryRaw: async (strings) => {
            const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
            if (sql.includes('"SystemConfig"')) {
              return [{
                globalBettingStatus: 'ACTIVE',
                betLimits: {
                  minBet: '1',
                  maxBet: '5',
                  maxPayoutPerBet: '25',
                  maxMarketLiability: '100',
                  maxUserOpenExposure: '25',
                },
              }];
            }
            if (sql.includes('"Wallet"')) {
              return [{
                id: walletId,
                userId: user.id,
                currency: 'XAN',
                availableBalance: '10',
                pendingWithdrawal: '0',
                status: 'ACTIVE',
              }];
            }
            if (sql.includes('FROM "Outcome"')) {
              return [{
                outcomeId,
                marketId,
                odds: '1.70',
                outcomeStatus: 'ACTIVE',
                eventId,
                marketStatus: 'OPEN',
                closesAt: '2026-09-13T12:05:00.000Z',
              }];
            }
            if (sql.includes('FROM "Bet"') && sql.includes('"userId"')) {
              return [{ totalOpenStake: '0' }];
            }
            if (sql.includes('FROM "Bet"')) {
              return [{ outcomeId, totalPotentialPayout: String(currentLiability) }];
            }
            return [];
          },
          $executeRaw: async (strings) => {
            const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
            if (sql.includes('pg_advisory_xact_lock')) {
              const previous = marketLock;
              let release;
              marketLock = new Promise((resolve) => {
                release = resolve;
              });
              await previous;
              tx.releaseMarketLock = release;
            }
            return 1;
          },
          ledgerEntry: { create: async ({ data }) => ({ id: `ledger-${accepted.length + 1}`, ...data }) },
          wallet: { update: async ({ data }) => ({ id: walletId, userId: user.id, availableBalance: data.availableBalance, pendingWithdrawal: '0', status: 'ACTIVE', currency: 'XAN' }) },
          bet: {
            create: async ({ data }) => {
              accepted.push(data);
              currentLiability += 1.7;
              return data;
            },
          },
        };

        try {
          return await fn(tx);
        } finally {
          tx.releaseMarketLock?.();
        }
      },
    };
  }

  const first = placeBet({ db: liabilityDb(), user, request: { marketId, outcomeId, stake: '1' }, now });
  const second = placeBet({ db: liabilityDb(), user, request: { marketId, outcomeId, stake: '1' }, now });
  const results = await Promise.allSettled([first, second]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(accepted.length, 1);
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
