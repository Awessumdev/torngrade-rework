import { assertAdminCanViewDashboard } from '../auth/authorization.mjs';

export class AdminDashboardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdminDashboardError';
    this.code = code;
  }
}

export const ADMIN_PAGES = Object.freeze([
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

const PAGE_CONFIG = Object.freeze({
  Events: { model: 'event', orderBy: { createdAt: 'desc' } },
  Markets: { model: 'market', orderBy: { createdAt: 'desc' } },
  Outcomes: { model: 'outcome', orderBy: { createdAt: 'desc' } },
  Bets: { model: 'bet', orderBy: { placedAt: 'desc' }, include: { event: true, market: true, outcome: true, user: true } },
  Users: { model: 'user', orderBy: { createdAt: 'desc' }, include: { wallet: true } },
  Wallets: { model: 'wallet', orderBy: { updatedAt: 'desc' }, include: { user: true } },
  Deposits: { model: 'deposit', orderBy: { createdAt: 'desc' }, include: { user: true } },
  Withdrawals: { model: 'withdrawal', orderBy: { requestedAt: 'desc' }, include: { user: true } },
  Ledger: { model: 'ledgerEntry', orderBy: { createdAt: 'desc' }, include: { user: true, wallet: true } },
  'Audit Logs': { model: 'auditLog', orderBy: { createdAt: 'desc' } },
  Reconciliation: { model: 'reconciliationSnapshot', orderBy: { checkedAt: 'desc' } },
});

function firstRow(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function getAdminDashboardMetrics({ db, admin, now = new Date() }) {
  assertAdminCanViewDashboard(admin);
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);

  const [
    walletTotals,
    depositTotals,
    wagerTotals,
    todayWagerTotals,
    openLiability,
    realizedPnL,
    marketCounts,
    activeUsers,
  ] = await Promise.all([
    db.$queryRaw`
      SELECT
        COALESCE(SUM("availableBalance"), 0)::text AS "totalUserBalance",
        COALESCE(SUM("pendingWithdrawal"), 0)::text AS "pendingWithdrawals"
      FROM "Wallet"
    `,
    db.$queryRaw`
      SELECT COALESCE(SUM("amount"), 0)::text AS "totalDeposits"
      FROM "Deposit"
      WHERE "status" = 'COMPLETED'
    `,
    db.$queryRaw`
      SELECT COALESCE(SUM("stake"), 0)::text AS "totalWagerVolume"
      FROM "Bet"
    `,
    db.$queryRaw`
      SELECT COALESCE(SUM("stake"), 0)::text AS "todaysWagerVolume"
      FROM "Bet"
      WHERE "placedAt" >= ${dayStart}
    `,
    db.$queryRaw`
      SELECT COALESCE(MAX("outcomePayout"), 0)::text AS "openBetLiability"
      FROM (
        SELECT "marketId", "outcomeId", SUM("potentialPayout") AS "outcomePayout"
        FROM "Bet"
        WHERE "status" = 'OPEN'
        GROUP BY "marketId", "outcomeId"
      ) exposure
    `,
    db.$queryRaw`
      SELECT
        (
          COALESCE(SUM("stake") FILTER (WHERE "status" IN ('WON', 'LOST')), 0)
          - COALESCE(SUM("potentialPayout") FILTER (WHERE "status" = 'WON'), 0)
        )::text AS "realizedPnL"
      FROM "Bet"
    `,
    db.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE "status" IN ('OPEN', 'SUSPENDED'))::int AS "openMarkets",
        COUNT(*) FILTER (WHERE "status" = 'SETTLED')::int AS "settledMarkets"
      FROM "Market"
    `,
    db.$queryRaw`
      SELECT COUNT(DISTINCT "userId")::int AS "activeUsers"
      FROM "Bet"
      WHERE "placedAt" >= ${dayStart}
    `,
  ]);

  return {
    totalUserBalance: firstRow(walletTotals).totalUserBalance,
    pendingWithdrawals: firstRow(walletTotals).pendingWithdrawals,
    totalDeposits: firstRow(depositTotals).totalDeposits,
    todaysWagerVolume: firstRow(todayWagerTotals).todaysWagerVolume,
    totalWagerVolume: firstRow(wagerTotals).totalWagerVolume,
    openBetLiability: firstRow(openLiability).openBetLiability,
    realizedPnL: firstRow(realizedPnL).realizedPnL,
    openMarkets: firstRow(marketCounts).openMarkets,
    settledMarkets: firstRow(marketCounts).settledMarkets,
    activeUsers: firstRow(activeUsers).activeUsers,
  };
}

export function getAdminPages({ admin }) {
  assertAdminCanViewDashboard(admin);
  return [...ADMIN_PAGES];
}

export async function listAdminPage({ db, admin, page, take = 50, cursor = null }) {
  assertAdminCanViewDashboard(admin);
  const config = PAGE_CONFIG[page];

  if (!config) {
    throw new AdminDashboardError('UNKNOWN_ADMIN_PAGE', 'Admin page is unknown.');
  }

  return db[config.model].findMany({
    take,
    orderBy: config.orderBy,
    ...(config.include ? { include: config.include } : {}),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}
