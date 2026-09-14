import assert from 'node:assert/strict';
import {
  MARKET_STATUSES,
  assertMarketTransitionAllowed,
  canMarketAcceptNewBet,
  transitionMarketStatus,
} from '../src/markets/market-lifecycle.mjs';
import { ADMIN_ROLES, ADMIN_STATUS } from '../src/auth/authorization.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const admin = {
  id: '00000000-0000-0000-0000-00000000a001',
  status: ADMIN_STATUS.ACTIVE,
  roles: [ADMIN_ROLES.MARKET_MANAGER],
};
const marketId = '00000000-0000-0000-0000-0000000000bb';

function createLifecycleDb({ currentStatus }) {
  const calls = [];
  const market = {
    id: marketId,
    status: currentStatus,
    closesAt: '2026-09-13T12:05:00.000Z',
  };

  return {
    calls,
    db: {
      $transaction: async (fn) => fn({
        $queryRaw: async () => {
          calls.push(['lockMarket']);
          return [market];
        },
        market: {
          update: async ({ where, data }) => {
            calls.push(['updateMarket', { where, data }]);
            return { ...market, ...data };
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

test('allows only the defined market lifecycle transitions', () => {
  for (const [from, to] of [
    [MARKET_STATUSES.DRAFT, MARKET_STATUSES.OPEN],
    [MARKET_STATUSES.OPEN, MARKET_STATUSES.SUSPENDED],
    [MARKET_STATUSES.SUSPENDED, MARKET_STATUSES.OPEN],
    [MARKET_STATUSES.OPEN, MARKET_STATUSES.CLOSED],
    [MARKET_STATUSES.CLOSED, MARKET_STATUSES.SETTLING],
    [MARKET_STATUSES.SETTLING, MARKET_STATUSES.SETTLED],
    [MARKET_STATUSES.DRAFT, MARKET_STATUSES.VOID],
    [MARKET_STATUSES.OPEN, MARKET_STATUSES.VOID],
    [MARKET_STATUSES.SUSPENDED, MARKET_STATUSES.VOID],
    [MARKET_STATUSES.CLOSED, MARKET_STATUSES.VOID],
    [MARKET_STATUSES.SETTLING, MARKET_STATUSES.VOID],
  ]) {
    assert.doesNotThrow(() => assertMarketTransitionAllowed(from, to));
  }

  for (const [from, to] of [
    [MARKET_STATUSES.DRAFT, MARKET_STATUSES.CLOSED],
    [MARKET_STATUSES.CLOSED, MARKET_STATUSES.OPEN],
    [MARKET_STATUSES.SUSPENDED, MARKET_STATUSES.CLOSED],
    [MARKET_STATUSES.SETTLED, MARKET_STATUSES.VOID],
    [MARKET_STATUSES.VOID, MARKET_STATUSES.OPEN],
  ]) {
    assert.throws(
      () => assertMarketTransitionAllowed(from, to),
      (error) => error.code === 'INVALID_MARKET_TRANSITION',
    );
  }
});

test('market accepts new bets only when OPEN and server time is before closesAt', () => {
  const beforeClose = new Date('2026-09-13T12:00:00.000Z');
  const afterClose = new Date('2026-09-13T12:06:00.000Z');

  assert.equal(canMarketAcceptNewBet({ status: 'OPEN', closesAt: '2026-09-13T12:05:00.000Z' }, beforeClose), true);
  assert.equal(canMarketAcceptNewBet({ status: 'OPEN', closesAt: '2026-09-13T12:05:00.000Z' }, afterClose), false);
  assert.equal(canMarketAcceptNewBet({ status: 'SUSPENDED', closesAt: '2026-09-13T12:05:00.000Z' }, beforeClose), false);
  assert.equal(canMarketAcceptNewBet({ status: 'CLOSED', closesAt: '2026-09-13T12:05:00.000Z' }, beforeClose), false);
  assert.equal(canMarketAcceptNewBet({ status: 'SETTLED', closesAt: '2026-09-13T12:05:00.000Z' }, beforeClose), false);
  assert.equal(canMarketAcceptNewBet({ status: 'VOID', closesAt: '2026-09-13T12:05:00.000Z' }, beforeClose), false);
});

test('transition updates market under lock and writes audit log', async () => {
  const { db, calls } = createLifecycleDb({ currentStatus: MARKET_STATUSES.OPEN });

  const updated = await transitionMarketStatus({
    db,
    admin,
    marketId,
    toStatus: MARKET_STATUSES.CLOSED,
    reason: 'market close requested',
  });

  assert.equal(updated.status, MARKET_STATUSES.CLOSED);
  assert.deepEqual(calls.map(([name]) => name), ['lockMarket', 'updateMarket', 'audit']);
  assert.equal(calls[2][1].action, 'MARKET_STATUS_TRANSITION');
  assert.equal(calls[2][1].before.status, MARKET_STATUSES.OPEN);
  assert.equal(calls[2][1].after.status, MARKET_STATUSES.CLOSED);
});

test('invalid transition does not update or audit', async () => {
  const { db, calls } = createLifecycleDb({ currentStatus: MARKET_STATUSES.CLOSED });

  await assert.rejects(
    () => transitionMarketStatus({ db, admin, marketId, toStatus: MARKET_STATUSES.OPEN }),
    (error) => error.code === 'INVALID_MARKET_TRANSITION',
  );

  assert.deepEqual(calls.map(([name]) => name), ['lockMarket']);
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
