import assert from 'node:assert/strict';
import {
  buildMarketOddsSummary,
  impliedProbability,
  parseDecimalOdds,
  updateOpenMarketOutcomeOdds,
} from '../src/markets/odds-service.mjs';
import { ADMIN_ROLES, ADMIN_STATUS } from '../src/auth/authorization.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const admin = {
  id: '00000000-0000-0000-0000-00000000a001',
  status: ADMIN_STATUS.ACTIVE,
  roles: [ADMIN_ROLES.MARKET_MANAGER],
};

const outcomeId = '00000000-0000-0000-0000-000000000011';
const marketId = '00000000-0000-0000-0000-000000000022';

function createOddsDb({ marketStatus = 'OPEN', oldOdds = '1.70' } = {}) {
  const calls = [];
  const lockedOutcome = {
    id: outcomeId,
    marketId,
    lockedMarketId: marketId,
    marketStatus,
    name: 'YES',
    odds: oldOdds,
    status: 'ACTIVE',
    sortOrder: 1,
  };

  const tx = {
    $queryRaw: async () => {
      calls.push(['lockOutcomeAndMarket']);
      return [lockedOutcome];
    },
    outcome: {
      update: async ({ where, data }) => {
        calls.push(['updateOutcome', { where, data }]);
        return { ...lockedOutcome, odds: data.odds };
      },
    },
    bet: {
      updateMany: async () => {
        calls.push(['FORBIDDEN_BET_UPDATE']);
        throw new Error('Bet snapshots must not be updated');
      },
    },
    auditLog: {
      create: async ({ data }) => {
        calls.push(['audit', data]);
        return { id: 'audit-1', ...data };
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

test('calculates implied probability from decimal odds', () => {
  assert.equal(impliedProbability('1.70'), 0.588235);
  assert.equal(impliedProbability('2.05'), 0.487805);
  assert.throws(() => parseDecimalOdds('1'), (error) => error.code === 'INVALID_DECIMAL_ODDS');
});

test('builds admin market odds summary with current odds, probabilities, and overround', () => {
  const summary = buildMarketOddsSummary({
    id: marketId,
    question: 'Will Trump say yes?',
    status: 'OPEN',
    outcomes: [
      { id: 'no', name: 'NO', odds: '2.05', status: 'ACTIVE', sortOrder: 2 },
      { id: 'yes', name: 'YES', odds: '1.70', status: 'ACTIVE', sortOrder: 1 },
    ],
  });

  assert.deepEqual(summary.outcomes.map((outcome) => outcome.name), ['YES', 'NO']);
  assert.equal(summary.outcomes[0].currentOdds, '1.7');
  assert.equal(summary.outcomes[0].impliedProbability, 0.588235);
  assert.equal(summary.totalMarketOverround, 1.07604);
});

test('admin can update OPEN market outcome odds and writes audit log', async () => {
  const { db, calls } = createOddsDb();

  const result = await updateOpenMarketOutcomeOdds({
    db,
    admin,
    outcomeId,
    newOdds: '1.55',
    reason: 'risk adjustment',
  });

  assert.equal(result.changed, true);
  assert.equal(result.previousOdds, '1.7');
  assert.equal(result.newOdds, '1.55');
  assert.deepEqual(calls.map(([name]) => name), ['lockOutcomeAndMarket', 'updateOutcome', 'audit']);
  assert.equal(calls[1][1].data.odds, '1.55');
  assert.equal(calls[2][1].action, 'OUTCOME_ODDS_UPDATE');
  assert.equal(calls[2][1].before.odds, '1.7');
  assert.equal(calls[2][1].after.odds, '1.55');
  assert.equal(calls[2][1].metadata.marketId, marketId);
});

test('accepted bet oddsSnapshot is not updated when outcome odds changes', async () => {
  const { db, calls } = createOddsDb();

  await updateOpenMarketOutcomeOdds({
    db,
    admin,
    outcomeId,
    newOdds: '1.55',
  });

  assert.equal(calls.some(([name]) => name === 'FORBIDDEN_BET_UPDATE'), false);
});

test('non market manager admin cannot update odds', async () => {
  const { db } = createOddsDb();

  await assert.rejects(
    () => updateOpenMarketOutcomeOdds({
      db,
      admin: { id: admin.id, status: ADMIN_STATUS.ACTIVE, roles: [ADMIN_ROLES.AUDITOR] },
      outcomeId,
      newOdds: '1.55',
    }),
    (error) => error.code === 'ADMIN_FORBIDDEN',
  );
});

test('admin cannot update odds unless market is OPEN', async () => {
  const { db, calls } = createOddsDb({ marketStatus: 'CLOSED' });

  await assert.rejects(
    () => updateOpenMarketOutcomeOdds({ db, admin, outcomeId, newOdds: '1.55' }),
    (error) => error.code === 'MARKET_NOT_OPEN',
  );

  assert.deepEqual(calls.map(([name]) => name), ['lockOutcomeAndMarket']);
});

test('same odds is idempotent and does not write audit noise', async () => {
  const { db, calls } = createOddsDb({ oldOdds: '1.55' });

  const result = await updateOpenMarketOutcomeOdds({
    db,
    admin,
    outcomeId,
    newOdds: '1.55000000',
  });

  assert.equal(result.changed, false);
  assert.deepEqual(calls.map(([name]) => name), ['lockOutcomeAndMarket']);
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
