import assert from 'node:assert/strict';
import {
  ADMIN_PAGES,
  getAdminDashboardMetrics,
  getAdminPages,
  listAdminPage,
} from '../src/admin/admin-dashboard.mjs';
import { ADMIN_ROLES, ADMIN_STATUS } from '../src/auth/authorization.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const admin = {
  id: '00000000-0000-0000-0000-00000000a001',
  status: ADMIN_STATUS.ACTIVE,
  roles: [ADMIN_ROLES.AUDITOR],
};

test('dashboard exposes all requested admin pages', () => {
  assert.deepEqual(getAdminPages({ admin }), [
    'Events',
    'Markets',
    'Outcomes',
    'Bets',
    'Users',
    'Wallets',
    'Deposits',
    'Withdrawals',
    'Ledger',
    'Audit Logs',
    'Reconciliation',
  ]);
  assert.deepEqual(ADMIN_PAGES, getAdminPages({ admin }));
});

test('dashboard metrics returns financial and operational totals', async () => {
  const queries = [];
  const db = {
    $queryRaw: async (strings) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      queries.push(sql);
      if (sql.includes('FROM "Wallet"')) return [{ totalUserBalance: '100', pendingWithdrawals: '7' }];
      if (sql.includes('FROM "Deposit"')) return [{ totalDeposits: '120' }];
      if (sql.includes('todaysWagerVolume')) return [{ todaysWagerVolume: '9' }];
      if (sql.includes('totalWagerVolume')) return [{ totalWagerVolume: '44' }];
      if (sql.includes('openBetLiability')) return [{ openBetLiability: '10' }];
      if (sql.includes('realizedPnL')) return [{ realizedPnL: '4.5' }];
      if (sql.includes('openMarkets')) return [{ openMarkets: 3, settledMarkets: 8 }];
      if (sql.includes('activeUsers')) return [{ activeUsers: 5 }];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const metrics = await getAdminDashboardMetrics({
    db,
    admin,
    now: new Date('2026-09-13T16:00:00.000Z'),
  });

  assert.deepEqual(metrics, {
    totalUserBalance: '100',
    pendingWithdrawals: '7',
    totalDeposits: '120',
    todaysWagerVolume: '9',
    totalWagerVolume: '44',
    openBetLiability: '10',
    realizedPnL: '4.5',
    openMarkets: 3,
    settledMarkets: 8,
    activeUsers: 5,
  });
  assert.equal(queries.length, 8);
});

test('admin pages map to read-only model listings', async () => {
  const called = [];
  const db = {
    event: { findMany: async (args) => { called.push(['event', args]); return []; } },
    bet: { findMany: async (args) => { called.push(['bet', args]); return []; } },
    ledgerEntry: { findMany: async (args) => { called.push(['ledgerEntry', args]); return []; } },
  };

  await listAdminPage({ db, admin, page: 'Events' });
  await listAdminPage({ db, admin, page: 'Bets', take: 10 });
  await listAdminPage({ db, admin, page: 'Ledger' });

  assert.equal(called[0][0], 'event');
  assert.equal(called[1][0], 'bet');
  assert.deepEqual(called[1][1].include, { event: true, market: true, outcome: true, user: true });
  assert.equal(called[2][0], 'ledgerEntry');
  assert.deepEqual(called[2][1].include, { user: true, wallet: true });
});

test('non-auditor admin cannot view dashboard or pages', async () => {
  const badAdmin = { id: admin.id, status: ADMIN_STATUS.ACTIVE, roles: [ADMIN_ROLES.WHITELIST_MANAGER] };
  const db = { $queryRaw: async () => [] };

  assert.throws(
    () => getAdminPages({ admin: badAdmin }),
    (error) => error.code === 'ADMIN_FORBIDDEN',
  );

  await assert.rejects(
    () => getAdminDashboardMetrics({ db, admin: badAdmin }),
    (error) => error.code === 'ADMIN_FORBIDDEN',
  );
});

test('unknown admin page is rejected', async () => {
  await assert.rejects(
    () => listAdminPage({ db: {}, admin, page: 'Secrets' }),
    (error) => error.code === 'UNKNOWN_ADMIN_PAGE',
  );
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
