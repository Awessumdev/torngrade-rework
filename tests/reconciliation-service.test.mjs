import assert from 'node:assert/strict';
import {
  RECONCILIATION_SEVERITY,
  buildReconciliationReport,
  runReconciliation,
} from '../src/reconciliation/reconciliation-service.mjs';
import { ADMIN_ROLES, ADMIN_STATUS } from '../src/auth/authorization.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const admin = {
  id: '00000000-0000-0000-0000-00000000a001',
  status: ADMIN_STATUS.ACTIVE,
  roles: [ADMIN_ROLES.AUDITOR],
};

test('builds clean reconciliation report with expected actual difference fields', () => {
  const report = buildReconciliationReport({
    userBalances: { expected: '90', actual: '90' },
    pendingWithdrawals: { expected: '5', actual: '5' },
    openBetStakes: { expected: '7', actual: '7' },
    openBetLiabilities: { expected: '12', actual: '12' },
    houseEquity: { expected: '93', actual: '93' },
    actualAssets: { expected: '200', actual: '200' },
  });

  assert.equal(report.status, 'CLEAN');
  assert.equal(report.severity, RECONCILIATION_SEVERITY.CLEAN);
  assert.equal(report.autoFix, false);
  assert.equal(report.requiresInvestigation, false);
  assert.equal(report.mismatchCount, 0);
  assert.deepEqual(report.items.map((item) => item.name), [
    'userBalances',
    'pendingWithdrawals',
    'openBetStakes',
    'openBetLiabilities',
    'houseEquity',
    'actualAssets',
  ]);
  assert.equal(report.items[0].difference, '0');
});

test('marks every mismatch CRITICAL and requires investigation without auto-fix', () => {
  const report = buildReconciliationReport({
    userBalances: { expected: '90', actual: '89' },
    pendingWithdrawals: { expected: '5', actual: '5' },
    openBetStakes: { expected: '7', actual: '8' },
    openBetLiabilities: { expected: '12', actual: '12' },
    houseEquity: { expected: '93', actual: '93' },
    actualAssets: { expected: '200', actual: '199' },
  });

  assert.equal(report.status, 'MISMATCH');
  assert.equal(report.severity, RECONCILIATION_SEVERITY.CRITICAL);
  assert.equal(report.autoFix, false);
  assert.equal(report.requiresInvestigation, true);
  assert.equal(report.mismatchCount, 3);
  assert.equal(report.items.find((item) => item.name === 'userBalances').severity, 'CRITICAL');
  assert.equal(report.items.find((item) => item.name === 'openBetStakes').difference, '1');
  assert.equal(report.items.find((item) => item.name === 'actualAssets').difference, '-1');
});

test('runReconciliation aggregates data, stores snapshot, and returns admin-visible report', async () => {
  const queries = [];
  let snapshotData;
  const db = {
    $queryRaw: async (strings) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      queries.push(sql);
      if (sql.includes('FROM "Wallet"')) {
        return [{ userBalances: '90', pendingWithdrawals: '5', walletCount: 4 }];
      }
      if (sql.includes('FROM "LedgerEntry"')) {
        return [{ ledgerUserBalances: '90', totalLedgerEntries: 20 }];
      }
      if (sql.includes('openBetStakes')) {
        return [{ openBetStakes: '7' }];
      }
      if (sql.includes('openBetLiabilities')) {
        return [{ openBetLiabilities: '12' }];
      }
      if (sql.includes('FROM "Withdrawal"')) {
        return [{ paidWithdrawals: '10' }];
      }
      if (sql.includes('FROM "Deposit"')) {
        return [{ completedDeposits: '110' }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    reconciliationSnapshot: {
      create: async ({ data }) => {
        snapshotData = data;
        return { id: 'snapshot-1', ...data };
      },
    },
  };

  const { report, snapshot, globalBettingSuspended } = await runReconciliation({
    db,
    admin,
    actualAssets: '100',
    now: new Date('2026-09-14T06:30:00.000Z'),
  });

  assert.equal(queries.length, 6);
  assert.equal(report.items.find((item) => item.name === 'actualAssets').expected, '100');
  assert.equal(report.items.find((item) => item.name === 'houseEquity').actual, '-7');
  assert.equal(snapshot.walletCount, 4);
  assert.equal(snapshot.totalLedgerEntries, 20);
  assert.deepEqual(snapshotData.details, report);
  assert.equal(globalBettingSuspended, false);
});

test('critical reconciliation mismatch suspends global betting and audits without auto-fix', async () => {
  const calls = [];
  const db = {
    $queryRaw: async (strings) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('FROM "Wallet"')) {
        return [{ userBalances: '90', pendingWithdrawals: '5', walletCount: 4 }];
      }
      if (sql.includes('FROM "LedgerEntry"')) return [{ ledgerUserBalances: '91', totalLedgerEntries: 20 }];
      if (sql.includes('openBetStakes')) return [{ openBetStakes: '7' }];
      if (sql.includes('openBetLiabilities')) return [{ openBetLiabilities: '12' }];
      if (sql.includes('FROM "Withdrawal"')) return [{ paidWithdrawals: '10' }];
      if (sql.includes('FROM "Deposit"')) return [{ completedDeposits: '110' }];
      throw new Error(`Unexpected query: ${sql}`);
    },
    $transaction: async (fn) => fn({
      reconciliationSnapshot: {
        create: async ({ data }) => {
          calls.push(['snapshot', data]);
          return { id: 'snapshot-1', ...data };
        },
      },
      $queryRaw: async () => {
        calls.push(['lockSystemConfig']);
        return [{ key: 'production', globalBettingStatus: 'ACTIVE', betLimits: {} }];
      },
      systemConfig: {
        update: async ({ data }) => {
          calls.push(['suspendSystemConfig', data]);
          return { key: 'production', betLimits: {}, ...data };
        },
        create: async ({ data }) => data,
      },
      auditLog: {
        create: async ({ data }) => {
          calls.push(['audit', data]);
          return data;
        },
      },
    }),
  };

  const { report, globalBettingSuspended } = await runReconciliation({ db, admin, actualAssets: '100' });

  assert.equal(report.severity, RECONCILIATION_SEVERITY.CRITICAL);
  assert.equal(globalBettingSuspended, true);
  assert.equal(calls.find(([name]) => name === 'suspendSystemConfig')[1].globalBettingStatus, 'SUSPENDED');
  assert.equal(calls.find(([name]) => name === 'audit')[1].action, 'GLOBAL_BETTING_STATUS_CHANGED');
});

test('non-auditor cannot run reconciliation', async () => {
  const badAdmin = { id: admin.id, status: ADMIN_STATUS.ACTIVE, roles: [ADMIN_ROLES.MARKET_MANAGER] };

  await assert.rejects(
    () => runReconciliation({ db: {}, admin: badAdmin, actualAssets: '0' }),
    (error) => error.code === 'ADMIN_FORBIDDEN',
  );
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
