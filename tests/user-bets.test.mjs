import assert from 'node:assert/strict';
import {
  getUserBetDetail,
  listUserBets,
  serializeUserBet,
} from '../src/users/user-bets.mjs';
import { USER_STATUS, WHITELIST_STATUS } from '../src/auth/authorization.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const user = {
  id: '00000000-0000-0000-0000-000000000001',
  status: USER_STATUS.ACTIVE,
  whitelistEntries: [{ status: WHITELIST_STATUS.ACTIVE }],
};
const betId = '00000000-0000-0000-0000-0000000000b1';

function sampleBet(overrides = {}) {
  return {
    id: betId,
    userId: user.id,
    event: {
      id: 'event-1',
      title: 'Trump Speech',
      slug: 'trump-speech',
    },
    market: {
      id: 'market-1',
      question: 'Will Trump say yes?',
    },
    outcome: {
      id: 'outcome-1',
      name: 'YES',
    },
    stake: '1',
    oddsSnapshot: '1.70',
    potentialPayout: '1.7',
    status: 'OPEN',
    placedAt: new Date('2026-09-13T12:00:00.000Z'),
    settledAt: null,
    ...overrides,
  };
}

test('serializes user-visible bet fields only', () => {
  const serialized = serializeUserBet(sampleBet({ privateField: 'hidden' }));

  assert.deepEqual(Object.keys(serialized), [
    'id',
    'event',
    'market',
    'outcome',
    'stake',
    'oddsSnapshot',
    'potentialPayout',
    'status',
    'placedAt',
    'settledAt',
  ]);
  assert.equal(serialized.event.title, 'Trump Speech');
  assert.equal(serialized.market.question, 'Will Trump say yes?');
  assert.equal(serialized.outcome.name, 'YES');
});

test('lists only the authenticated user bets and visible statuses', async () => {
  let capturedArgs;
  const db = {
    bet: {
      findMany: async (args) => {
        capturedArgs = args;
        return [
          sampleBet({ status: 'OPEN' }),
          sampleBet({ id: 'bet-2', status: 'WON', settledAt: new Date('2026-09-13T13:00:00.000Z') }),
        ];
      },
    },
  };

  const bets = await listUserBets({ db, user });

  assert.equal(bets.length, 2);
  assert.equal(capturedArgs.where.userId, user.id);
  assert.deepEqual(capturedArgs.where.status, { in: ['OPEN', 'WON', 'LOST', 'VOID'] });
  assert.deepEqual(capturedArgs.include, { event: true, market: true, outcome: true });
});

test('supports status filter for OPEN WON LOST VOID only', async () => {
  let capturedArgs;
  const db = {
    bet: {
      findMany: async (args) => {
        capturedArgs = args;
        return [sampleBet({ status: 'VOID' })];
      },
    },
  };

  const bets = await listUserBets({ db, user, status: 'VOID' });

  assert.equal(bets[0].status, 'VOID');
  assert.deepEqual(capturedArgs.where.status, { equals: 'VOID' });

  await assert.rejects(
    () => listUserBets({ db, user, status: 'SETTLING' }),
    (error) => error.code === 'INVALID_BET_STATUS_FILTER',
  );
});

test('bet detail is scoped by authenticated user id to prevent IDOR', async () => {
  let capturedArgs;
  const db = {
    bet: {
      findFirst: async (args) => {
        capturedArgs = args;
        return sampleBet();
      },
    },
  };

  const detail = await getUserBetDetail({ db, user, betId });

  assert.equal(detail.id, betId);
  assert.deepEqual(capturedArgs.where, {
    id: betId,
    userId: user.id,
    status: { in: ['OPEN', 'WON', 'LOST', 'VOID'] },
  });
});

test('another user private bet detail is not returned', async () => {
  const db = {
    bet: {
      findFirst: async (args) => {
        assert.equal(args.where.userId, user.id);
        return null;
      },
    },
  };

  await assert.rejects(
    () => getUserBetDetail({ db, user, betId: 'someone-else-bet' }),
    (error) => error.code === 'BET_NOT_FOUND',
  );
});

test('inactive user cannot list or view bet details', async () => {
  const db = {
    bet: {
      findMany: async () => {
        throw new Error('query should not run');
      },
      findFirst: async () => {
        throw new Error('query should not run');
      },
    },
  };
  const blockedUser = { ...user, status: USER_STATUS.SUSPENDED, whitelistEntries: [] };

  await assert.rejects(
    () => listUserBets({ db, user: blockedUser }),
    (error) => error.code === 'USER_NOT_ACTIVE',
  );

  await assert.rejects(
    () => getUserBetDetail({ db, user: blockedUser, betId }),
    (error) => error.code === 'USER_NOT_ACTIVE',
  );
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
