import { assertAdminCanViewDashboard } from '../auth/authorization.mjs';
import { moneyToString, parseMoney } from '../wallet/wallet-service.mjs';
import { suspendGlobalBettingInTransaction } from '../system/system-config.mjs';

export const RECONCILIATION_SEVERITY = Object.freeze({
  CLEAN: 'CLEAN',
  CRITICAL: 'CRITICAL',
});

export class ReconciliationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconciliationError';
    this.code = code;
  }
}

const MONEY_SCALE = 18n;
const MONEY_FACTOR = 10n ** MONEY_SCALE;

function parseStoredMoney(value) {
  const raw = String(value ?? '0').trim();
  if (!/^-?(0|[1-9]\d*)(\.\d{1,18})?$/.test(raw)) {
    throw new ReconciliationError('INVALID_STORED_MONEY', 'Stored monetary value is invalid.');
  }

  if (raw === '0' || raw === '-0') {
    return 0n;
  }

  if (raw.startsWith('-')) {
    return -parseMoney(raw.slice(1));
  }

  return parseMoney(raw);
}

function difference(expected, actual) {
  return actual - expected;
}

function buildLineItem(name, expected, actual) {
  const diff = difference(expected, actual);
  return {
    name,
    expected: moneyToString(expected),
    actual: moneyToString(actual),
    difference: moneyToString(diff),
    severity: diff === 0n ? RECONCILIATION_SEVERITY.CLEAN : RECONCILIATION_SEVERITY.CRITICAL,
    requiresInvestigation: diff !== 0n,
  };
}

export function buildReconciliationReport({
  userBalances,
  pendingWithdrawals,
  openBetStakes,
  openBetLiabilities,
  houseEquity,
  actualAssets,
}) {
  const expectedUserBalances = parseStoredMoney(userBalances.expected);
  const actualUserBalances = parseStoredMoney(userBalances.actual);
  const expectedPendingWithdrawals = parseStoredMoney(pendingWithdrawals.expected);
  const actualPendingWithdrawals = parseStoredMoney(pendingWithdrawals.actual);
  const expectedOpenBetStakes = parseStoredMoney(openBetStakes.expected);
  const actualOpenBetStakes = parseStoredMoney(openBetStakes.actual);
  const expectedOpenBetLiabilities = parseStoredMoney(openBetLiabilities.expected);
  const actualOpenBetLiabilities = parseStoredMoney(openBetLiabilities.actual);
  const actualAssetsValue = parseStoredMoney(actualAssets.actual);
  const expectedHouseEquity = houseEquity?.expected == null
    ? actualAssetsValue - actualUserBalances - actualPendingWithdrawals - actualOpenBetLiabilities
    : parseStoredMoney(houseEquity.expected);
  const actualHouseEquity = parseStoredMoney(houseEquity.actual);

  const items = [
    buildLineItem('userBalances', expectedUserBalances, actualUserBalances),
    buildLineItem('pendingWithdrawals', expectedPendingWithdrawals, actualPendingWithdrawals),
    buildLineItem('openBetStakes', expectedOpenBetStakes, actualOpenBetStakes),
    buildLineItem('openBetLiabilities', expectedOpenBetLiabilities, actualOpenBetLiabilities),
    buildLineItem('houseEquity', expectedHouseEquity, actualHouseEquity),
    buildLineItem('actualAssets', parseStoredMoney(actualAssets.expected), actualAssetsValue),
  ];

  const mismatches = items.filter((item) => item.severity === RECONCILIATION_SEVERITY.CRITICAL);

  return {
    status: mismatches.length === 0 ? 'CLEAN' : 'MISMATCH',
    severity: mismatches.length === 0 ? RECONCILIATION_SEVERITY.CLEAN : RECONCILIATION_SEVERITY.CRITICAL,
    autoFix: false,
    requiresInvestigation: mismatches.length > 0,
    items,
    mismatchCount: mismatches.length,
  };
}

export async function runReconciliation({ db, admin, actualAssets, now = new Date(), suspendOnCritical = true }) {
  assertAdminCanViewDashboard(admin);

  const [
    walletRows,
    ledgerRows,
    openBetRows,
    openLiabilityRows,
    paidWithdrawalRows,
    depositRows,
  ] = await Promise.all([
    db.$queryRaw`
      SELECT
        COALESCE(SUM("availableBalance"), 0)::text AS "userBalances",
        COALESCE(SUM("pendingWithdrawal"), 0)::text AS "pendingWithdrawals",
        COUNT(*)::int AS "walletCount"
      FROM "Wallet"
    `,
    db.$queryRaw`
      SELECT
        COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amount" ELSE -"amount" END), 0)::text AS "ledgerUserBalances",
        COUNT(*)::int AS "totalLedgerEntries"
      FROM "LedgerEntry"
      WHERE "type" <> 'WITHDRAWAL_PAID'
    `,
    db.$queryRaw`
      SELECT COALESCE(SUM("stake"), 0)::text AS "openBetStakes"
      FROM "Bet"
      WHERE "status" = 'OPEN'
    `,
    db.$queryRaw`
      SELECT COALESCE(MAX("outcomePayout"), 0)::text AS "openBetLiabilities"
      FROM (
        SELECT "marketId", "outcomeId", SUM("potentialPayout") AS "outcomePayout"
        FROM "Bet"
        WHERE "status" = 'OPEN'
        GROUP BY "marketId", "outcomeId"
      ) exposure
    `,
    db.$queryRaw`
      SELECT COALESCE(SUM("amount"), 0)::text AS "paidWithdrawals"
      FROM "Withdrawal"
      WHERE "status" = 'PAID'
    `,
    db.$queryRaw`
      SELECT COALESCE(SUM("amount"), 0)::text AS "completedDeposits"
      FROM "Deposit"
      WHERE "status" = 'COMPLETED'
    `,
  ]);

  const wallets = Array.isArray(walletRows) ? walletRows[0] : walletRows;
  const ledger = Array.isArray(ledgerRows) ? ledgerRows[0] : ledgerRows;
  const openBets = Array.isArray(openBetRows) ? openBetRows[0] : openBetRows;
  const openLiability = Array.isArray(openLiabilityRows) ? openLiabilityRows[0] : openLiabilityRows;
  const paidWithdrawals = Array.isArray(paidWithdrawalRows) ? paidWithdrawalRows[0] : paidWithdrawalRows;
  const deposits = Array.isArray(depositRows) ? depositRows[0] : depositRows;

  const actualAssetsValue = String(actualAssets);
  const expectedAssets = moneyToString(
    parseStoredMoney(deposits.completedDeposits) - parseStoredMoney(paidWithdrawals.paidWithdrawals),
  );

  const report = buildReconciliationReport({
    userBalances: {
      expected: ledger.ledgerUserBalances,
      actual: wallets.userBalances,
    },
    pendingWithdrawals: {
      expected: paidWithdrawals.pendingWithdrawals ?? wallets.pendingWithdrawals,
      actual: wallets.pendingWithdrawals,
    },
    openBetStakes: {
      expected: openBets.openBetStakes,
      actual: openBets.openBetStakes,
    },
    openBetLiabilities: {
      expected: openLiability.openBetLiabilities,
      actual: openLiability.openBetLiabilities,
    },
    houseEquity: {
      actual: moneyToString(
        parseStoredMoney(actualAssetsValue)
        - parseStoredMoney(wallets.userBalances)
        - parseStoredMoney(wallets.pendingWithdrawals)
        - parseStoredMoney(openLiability.openBetLiabilities),
      ),
    },
    actualAssets: {
      expected: expectedAssets,
      actual: actualAssetsValue,
    },
  });

  const writeSnapshot = async (tx) => tx.reconciliationSnapshot.create({
    data: {
      status: report.status,
      walletCount: wallets.walletCount,
      mismatchCount: report.mismatchCount,
      totalLedgerEntries: ledger.totalLedgerEntries,
      checkedAt: now,
      details: report,
    },
  });

  let snapshot;
  let globalBettingSuspended = false;
  if (suspendOnCritical && report.severity === RECONCILIATION_SEVERITY.CRITICAL && db.$transaction) {
    const result = await db.$transaction(async (tx) => {
      const createdSnapshot = await writeSnapshot(tx);
      await suspendGlobalBettingInTransaction({
        tx,
        reason: 'CRITICAL_RECONCILIATION_MISMATCH',
        now,
      });
      return createdSnapshot;
    });
    snapshot = result;
    globalBettingSuspended = true;
  } else {
    snapshot = await writeSnapshot(db);
  }

  return { report, snapshot, globalBettingSuspended };
}
