import { randomUUID } from 'node:crypto';
import { assertAdminCanSettleMarkets } from '../auth/authorization.mjs';
import {
  LEDGER_DIRECTIONS,
  LEDGER_ENTRY_TYPES,
  allowWalletMutationInCurrentTransaction,
  createLedgerBackedBalanceChange,
  lockWalletForUpdate,
  moneyToString,
  parseMoney,
} from '../wallet/wallet-service.mjs';
import { MARKET_STATUSES } from '../markets/market-lifecycle.mjs';

export class SettlementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettlementError';
    this.code = code;
  }
}

function parseStoredMoney(value) {
  const raw = String(value ?? '0').trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(raw)) {
    throw new SettlementError('INVALID_STORED_MONEY', 'Stored monetary value is invalid.');
  }

  if (raw === '0') {
    return 0n;
  }

  return parseMoney(raw);
}

export function buildSettlementPreview({ market, winningOutcome, aggregate }) {
  if (market.status !== MARKET_STATUSES.CLOSED) {
    throw new SettlementError('MARKET_NOT_CLOSED', 'Only CLOSED markets can be previewed for settlement.');
  }

  if (winningOutcome.marketId !== market.id) {
    throw new SettlementError('WINNING_OUTCOME_MARKET_MISMATCH', 'Winning outcome does not belong to market.');
  }

  const winningBetCount = Number(aggregate.winningBetCount ?? 0);
  const losingBetCount = Number(aggregate.losingBetCount ?? 0);
  const totalWinningStake = parseStoredMoney(aggregate.totalWinningStake ?? '0');
  const totalPayout = parseStoredMoney(aggregate.totalPayout ?? '0');
  const totalStake = parseStoredMoney(aggregate.totalStake ?? '0');
  const currentSystemBalance = parseStoredMoney(aggregate.currentSystemBalance ?? '0');
  const requiredSettlementBalance = totalPayout;
  const settlementLiquiditySufficient = currentSystemBalance >= requiredSettlementBalance;

  return {
    market: {
      id: market.id,
      question: market.question,
      status: market.status,
    },
    winningOutcome: {
      id: winningOutcome.id,
      name: winningOutcome.name,
    },
    winningBetCount,
    losingBetCount,
    totalWinningStake: moneyToString(totalWinningStake),
    totalPayout: moneyToString(totalPayout),
    projectedPnL: moneyToString(totalStake - totalPayout),
    currentSystemBalance: moneyToString(currentSystemBalance),
    requiredSettlementBalance: moneyToString(requiredSettlementBalance),
    settlementLiquiditySufficient,
    criticalWarning: settlementLiquiditySufficient ? null : 'INSUFFICIENT_SETTLEMENT_LIQUIDITY',
    confirmation: {
      marketId: market.id,
      winningOutcome: winningOutcome.name,
      totalPayout: moneyToString(totalPayout),
      winningBets: winningBetCount,
    },
  };
}

export async function createSettlementPreview({ db, admin, marketId, winningOutcomeId }) {
  assertAdminCanSettleMarkets(admin);

  const market = await db.market.findUnique({
    where: { id: marketId },
    include: { outcomes: true },
  });

  if (!market) {
    throw new SettlementError('MARKET_NOT_FOUND', 'Market does not exist.');
  }

  const winningOutcome = market.outcomes.find((outcome) => outcome.id === winningOutcomeId);
  if (!winningOutcome) {
    throw new SettlementError('WINNING_OUTCOME_NOT_FOUND', 'Winning outcome does not exist on market.');
  }

  const rows = await db.$queryRaw`
    SELECT
      COUNT(*) FILTER (WHERE "outcomeId" = ${winningOutcomeId}::uuid)::int AS "winningBetCount",
      COUNT(*) FILTER (WHERE "outcomeId" <> ${winningOutcomeId}::uuid)::int AS "losingBetCount",
      COALESCE(SUM("stake") FILTER (WHERE "outcomeId" = ${winningOutcomeId}::uuid), 0)::text AS "totalWinningStake",
      COALESCE(SUM("potentialPayout") FILTER (WHERE "outcomeId" = ${winningOutcomeId}::uuid), 0)::text AS "totalPayout",
      COALESCE(SUM("stake"), 0)::text AS "totalStake"
    FROM "Bet"
    WHERE "marketId" = ${marketId}::uuid
      AND "status" = 'OPEN'
  `;
  const aggregate = Array.isArray(rows) ? rows[0] : rows;
  const balanceRows = await db.$queryRaw`
    SELECT COALESCE(SUM("availableBalance"), 0)::text AS "currentSystemBalance"
    FROM "Wallet"
  `;
  const balance = Array.isArray(balanceRows) ? balanceRows[0] : balanceRows;

  return buildSettlementPreview({
    market,
    winningOutcome,
    aggregate: { ...aggregate, currentSystemBalance: balance.currentSystemBalance },
  });
}

export function assertSettlementConfirmed({ preview, confirmation }) {
  if (!confirmation?.confirmed) {
    throw new SettlementError('SETTLEMENT_CONFIRMATION_REQUIRED', 'Settlement requires explicit second confirmation.');
  }

  if (
    confirmation.marketId !== preview.confirmation.marketId
    || confirmation.winningOutcomeId !== preview.winningOutcome.id
    || String(confirmation.totalPayout) !== preview.confirmation.totalPayout
    || Number(confirmation.winningBetCount) !== preview.confirmation.winningBets
  ) {
    throw new SettlementError('SETTLEMENT_CONFIRMATION_MISMATCH', 'Settlement confirmation does not match preview.');
  }
}

export async function initiateSettlementWithConfirmation({
  db,
  admin,
  marketId,
  winningOutcomeId,
  confirmation,
}) {
  assertAdminCanSettleMarkets(admin);

  return db.$transaction(async (tx) => {
    const marketRows = await tx.$queryRaw`
      SELECT * FROM "Market"
      WHERE "id" = ${marketId}::uuid
      FOR UPDATE
    `;
    const market = Array.isArray(marketRows) ? marketRows[0] : marketRows;

    if (!market) {
      throw new SettlementError('MARKET_NOT_FOUND', 'Market does not exist.');
    }

    if (market.status !== MARKET_STATUSES.CLOSED) {
      throw new SettlementError('MARKET_NOT_CLOSED', 'Only CLOSED markets can enter settlement.');
    }

    const winningOutcome = await tx.outcome.findFirst({
      where: { id: winningOutcomeId, marketId },
    });

    if (!winningOutcome) {
      throw new SettlementError('WINNING_OUTCOME_NOT_FOUND', 'Winning outcome does not exist on market.');
    }

    const rows = await tx.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE "outcomeId" = ${winningOutcomeId}::uuid)::int AS "winningBetCount",
        COUNT(*) FILTER (WHERE "outcomeId" <> ${winningOutcomeId}::uuid)::int AS "losingBetCount",
        COALESCE(SUM("stake") FILTER (WHERE "outcomeId" = ${winningOutcomeId}::uuid), 0)::text AS "totalWinningStake",
        COALESCE(SUM("potentialPayout") FILTER (WHERE "outcomeId" = ${winningOutcomeId}::uuid), 0)::text AS "totalPayout",
        COALESCE(SUM("stake"), 0)::text AS "totalStake"
      FROM "Bet"
      WHERE "marketId" = ${marketId}::uuid
        AND "status" = 'OPEN'
    `;
    const aggregate = Array.isArray(rows) ? rows[0] : rows;
    const balanceRows = await tx.$queryRaw`
      SELECT COALESCE(SUM("availableBalance"), 0)::text AS "currentSystemBalance"
      FROM "Wallet"
    `;
    const balance = Array.isArray(balanceRows) ? balanceRows[0] : balanceRows;
    const preview = buildSettlementPreview({
      market,
      winningOutcome,
      aggregate: { ...aggregate, currentSystemBalance: balance.currentSystemBalance },
    });
    assertSettlementConfirmed({ preview, confirmation });
    if (!preview.settlementLiquiditySufficient) {
      throw new SettlementError('INSUFFICIENT_SETTLEMENT_LIQUIDITY', 'Settlement liquidity is insufficient.');
    }

    const updatedMarket = await tx.market.update({
      where: { id: marketId },
      data: {
        status: MARKET_STATUSES.SETTLING,
        winningOutcomeId,
      },
    });

    const settlement = await tx.settlement.create({
      data: {
        id: randomUUID(),
        marketId,
        winningOutcomeId,
        status: 'PROCESSING',
        startedByAdminId: admin.id,
      },
    });

    await tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorAdminId: admin.id,
        action: 'SETTLEMENT_INITIATED',
        resourceType: 'Market',
        resourceId: marketId,
        before: { status: MARKET_STATUSES.CLOSED },
        after: {
          status: MARKET_STATUSES.SETTLING,
          winningOutcomeId,
        },
        metadata: { preview },
      },
    });

    return { market: updatedMarket, settlement, preview };
  });
}

export async function settleClosedMarketAtomically({
  db,
  admin,
  marketId,
  winningOutcomeId,
  now = new Date(),
}) {
  assertAdminCanSettleMarkets(admin);

  return db.$transaction(async (tx) => {
    const marketRows = await tx.$queryRaw`
      SELECT * FROM "Market"
      WHERE "id" = ${marketId}::uuid
      FOR UPDATE
    `;
    const market = Array.isArray(marketRows) ? marketRows[0] : marketRows;

    if (!market) {
      throw new SettlementError('MARKET_NOT_FOUND', 'Market does not exist.');
    }

    if (market.status === MARKET_STATUSES.SETTLED) {
      return {
        idempotent: true,
        market,
        paidWinningBetCount: 0,
        lostBetCount: 0,
        totalPayout: '0',
      };
    }

    if (![MARKET_STATUSES.CLOSED, MARKET_STATUSES.SETTLING].includes(market.status)) {
      throw new SettlementError('MARKET_NOT_CLOSED', 'Only CLOSED markets can be settled atomically.');
    }

    if (market.status === MARKET_STATUSES.SETTLING && market.winningOutcomeId && market.winningOutcomeId !== winningOutcomeId) {
      throw new SettlementError('SETTLEMENT_OUTCOME_MISMATCH', 'Market is already settling a different winning outcome.');
    }

    const winningOutcome = await tx.outcome.findFirst({
      where: { id: winningOutcomeId, marketId },
    });

    if (!winningOutcome) {
      throw new SettlementError('WINNING_OUTCOME_NOT_FOUND', 'Winning outcome does not exist on market.');
    }

    if (market.status === MARKET_STATUSES.CLOSED) {
      await tx.market.update({
        where: { id: marketId },
        data: {
          status: MARKET_STATUSES.SETTLING,
          winningOutcomeId,
        },
      });
    }

    const winningBets = await tx.$queryRaw`
      SELECT *
      FROM "Bet"
      WHERE "marketId" = ${marketId}::uuid
        AND "outcomeId" = ${winningOutcomeId}::uuid
        AND "status" = 'OPEN'
      FOR UPDATE
    `;
    const losingBets = await tx.$queryRaw`
      SELECT *
      FROM "Bet"
      WHERE "marketId" = ${marketId}::uuid
        AND "outcomeId" <> ${winningOutcomeId}::uuid
        AND "status" = 'OPEN'
      FOR UPDATE
    `;

    await allowWalletMutationInCurrentTransaction(tx);
    let totalPayoutMinor = 0n;

    for (const bet of winningBets) {
      const wallet = await lockWalletForUpdate(tx, bet.userId);
      await createLedgerBackedBalanceChange({
        tx,
        wallet,
        type: LEDGER_ENTRY_TYPES.BET_WIN,
        direction: LEDGER_DIRECTIONS.CREDIT,
        amount: String(bet.potentialPayout),
        referenceType: 'Bet',
        referenceId: bet.id,
        idempotencyKey: `bet-win:${bet.id}`,
        metadata: {
          marketId,
          outcomeId: winningOutcomeId,
          stake: String(bet.stake),
          oddsSnapshot: String(bet.oddsSnapshot),
        },
      });
      totalPayoutMinor += parseStoredMoney(bet.potentialPayout);
    }

    if (winningBets.length > 0) {
      await tx.bet.updateMany({
        where: { id: { in: winningBets.map((bet) => bet.id) }, status: 'OPEN' },
        data: { status: 'WON', settledAt: now },
      });
    }

    if (losingBets.length > 0) {
      await tx.bet.updateMany({
        where: { id: { in: losingBets.map((bet) => bet.id) }, status: 'OPEN' },
        data: { status: 'LOST', settledAt: now },
      });
    }

    const existingSettlement = tx.settlement.findUnique
      ? await tx.settlement.findUnique({ where: { marketId } })
      : null;
    const settlement = existingSettlement
      ? await tx.settlement.update({
        where: { marketId },
        data: {
          winningOutcomeId,
          status: 'COMPLETED',
          completedAt: now,
        },
      })
      : await tx.settlement.create({
        data: {
          id: randomUUID(),
          marketId,
          winningOutcomeId,
          status: 'COMPLETED',
          startedByAdminId: admin.id,
          completedAt: now,
        },
      });

    const settledMarket = await tx.market.update({
      where: { id: marketId },
      data: {
        status: MARKET_STATUSES.SETTLED,
        winningOutcomeId,
        settledAt: now,
      },
    });

    await tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorAdminId: admin.id,
        action: 'MARKET_SETTLED',
        resourceType: 'Market',
        resourceId: marketId,
        before: { status: market.status },
        after: {
          status: MARKET_STATUSES.SETTLED,
          winningOutcomeId,
          settledAt: now,
        },
        metadata: {
          winningBetCount: winningBets.length,
          losingBetCount: losingBets.length,
          totalPayout: moneyToString(totalPayoutMinor),
        },
      },
    });

    return {
      idempotent: false,
      market: settledMarket,
      settlement,
      paidWinningBetCount: winningBets.length,
      lostBetCount: losingBets.length,
      totalPayout: moneyToString(totalPayoutMinor),
    };
  });
}

export async function voidMarketWithRefundsAtomically({
  db,
  admin,
  marketId,
  reason = null,
  now = new Date(),
}) {
  assertAdminCanSettleMarkets(admin);

  return db.$transaction(async (tx) => {
    const marketRows = await tx.$queryRaw`
      SELECT * FROM "Market"
      WHERE "id" = ${marketId}::uuid
      FOR UPDATE
    `;
    const market = Array.isArray(marketRows) ? marketRows[0] : marketRows;

    if (!market) {
      throw new SettlementError('MARKET_NOT_FOUND', 'Market does not exist.');
    }

    if (market.status === MARKET_STATUSES.VOID) {
      return {
        idempotent: true,
        market,
        refundedBetCount: 0,
        totalRefund: '0',
      };
    }

    if (![MARKET_STATUSES.DRAFT, MARKET_STATUSES.OPEN, MARKET_STATUSES.SUSPENDED, MARKET_STATUSES.CLOSED, MARKET_STATUSES.SETTLING].includes(market.status)) {
      throw new SettlementError('MARKET_NOT_VOIDABLE', 'Market state is not eligible for void.');
    }

    const openBets = await tx.$queryRaw`
      SELECT *
      FROM "Bet"
      WHERE "marketId" = ${marketId}::uuid
        AND "status" = 'OPEN'
      FOR UPDATE
    `;

    await allowWalletMutationInCurrentTransaction(tx);
    let totalRefundMinor = 0n;

    for (const bet of openBets) {
      const wallet = await lockWalletForUpdate(tx, bet.userId);
      await createLedgerBackedBalanceChange({
        tx,
        wallet,
        type: LEDGER_ENTRY_TYPES.BET_VOID_REFUND,
        direction: LEDGER_DIRECTIONS.CREDIT,
        amount: String(bet.stake),
        referenceType: 'Bet',
        referenceId: bet.id,
        idempotencyKey: `bet-void-refund:${bet.id}`,
        metadata: {
          marketId,
          outcomeId: bet.outcomeId,
          stake: String(bet.stake),
        },
      });
      totalRefundMinor += parseStoredMoney(bet.stake);
    }

    if (openBets.length > 0) {
      await tx.bet.updateMany({
        where: { id: { in: openBets.map((bet) => bet.id) }, status: 'OPEN' },
        data: { status: 'VOID', settledAt: now },
      });
    }

    const voidedMarket = await tx.market.update({
      where: { id: marketId },
      data: {
        status: MARKET_STATUSES.VOID,
        settledAt: now,
      },
    });

    await tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorAdminId: admin.id,
        action: 'MARKET_VOIDED',
        resourceType: 'Market',
        resourceId: marketId,
        before: { status: market.status },
        after: {
          status: MARKET_STATUSES.VOID,
          settledAt: now,
        },
        metadata: {
          reason,
          refundedBetCount: openBets.length,
          totalRefund: moneyToString(totalRefundMinor),
        },
      },
    });

    return {
      idempotent: false,
      market: voidedMarket,
      refundedBetCount: openBets.length,
      totalRefund: moneyToString(totalRefundMinor),
    };
  });
}
