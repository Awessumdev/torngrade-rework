import { assertCanPlaceBet } from '../auth/authorization.mjs';
import { randomUUID } from 'node:crypto';
import {
  LEDGER_DIRECTIONS,
  LEDGER_ENTRY_TYPES,
  WalletError,
  allowWalletMutationInCurrentTransaction,
  createLedgerBackedBalanceChange,
  lockWalletForUpdate,
  moneyToString,
  parseMoney,
} from '../wallet/wallet-service.mjs';
import { decimalOddsToString, parseDecimalOdds } from '../markets/odds-service.mjs';
import { canMarketAcceptNewBet } from '../markets/market-lifecycle.mjs';
import {
  DEFAULT_PRODUCTION_BET_LIMITS,
  assertGlobalBettingActive,
  loadSystemConfigForBetting,
} from '../system/system-config.mjs';

export const DEFAULT_BET_LIMITS = DEFAULT_PRODUCTION_BET_LIMITS;
export const BET_LIMITS = DEFAULT_BET_LIMITS;

export class BetPlacementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BetPlacementError';
    this.code = code;
  }
}

const ODDS_SCALE = 8n;
const MONEY_SCALE = 18n;
const MONEY_FACTOR = 10n ** MONEY_SCALE;

export function normalizeBetRequest(input) {
  const allowedKeys = new Set(['marketId', 'outcomeId', 'stake']);
  for (const key of Object.keys(input ?? {})) {
    if (!allowedKeys.has(key)) {
      throw new BetPlacementError('CLIENT_FIELD_NOT_ALLOWED', `Client cannot submit ${key}.`);
    }
  }

  if (!input?.marketId || !input?.outcomeId) {
    throw new BetPlacementError('INVALID_BET_REQUEST', 'marketId and outcomeId are required.');
  }

  return {
    marketId: input.marketId,
    outcomeId: input.outcomeId,
    stake: moneyToString(parseMoney(input.stake)),
  };
}

export function calculatePotentialPayout(stake, decimalOdds) {
  const stakeMinor = parseMoney(stake);
  const oddsScaled = parseDecimalOdds(decimalOdds);
  const payoutMinor = (stakeMinor * oddsScaled) / (10n ** ODDS_SCALE);
  return moneyToString(payoutMinor);
}

export function validateBetLimits({ stake, potentialPayout, currentUserOpenStake = '0', limits = DEFAULT_BET_LIMITS }) {
  const stakeMinor = parseMoney(stake);

  if (stakeMinor < parseMoney(limits.minBet)) {
    throw new BetPlacementError('STAKE_BELOW_MIN', 'Stake is below minimum bet.');
  }

  if (stakeMinor > parseMoney(limits.maxBet)) {
    throw new BetPlacementError('STAKE_ABOVE_MAX', 'Stake is above maximum bet.');
  }

  if (parseMoney(potentialPayout) > parseMoney(limits.maxPayoutPerBet)) {
    throw new BetPlacementError('PAYOUT_ABOVE_MAX', 'Potential payout is above maximum per bet.');
  }

  if (parseStoredNonNegativeMoney(currentUserOpenStake) + stakeMinor > parseMoney(limits.maxUserOpenExposure)) {
    throw new BetPlacementError('USER_OPEN_EXPOSURE_LIMIT_EXCEEDED', 'User open exposure limit would be exceeded.');
  }
}

export function validateMarketLiability({ currentOutcomePayouts, outcomeId, newPotentialPayout, limits = DEFAULT_BET_LIMITS }) {
  const projected = new Map();

  for (const row of currentOutcomePayouts ?? []) {
    projected.set(row.outcomeId, parseStoredNonNegativeMoney(row.totalPotentialPayout ?? '0'));
  }

  const current = projected.get(outcomeId) ?? 0n;
  projected.set(outcomeId, current + parseMoney(newPotentialPayout));

  const worstCase = [...projected.values()].reduce((max, value) => (value > max ? value : max), 0n);

  if (worstCase > parseMoney(limits.maxMarketLiability)) {
    throw new BetPlacementError('MARKET_LIABILITY_LIMIT_EXCEEDED', 'Market liability limit would be exceeded.');
  }
}

export function buildMarketRiskSummary({ market, outcomeRiskRows = [] }) {
  const rowByOutcome = new Map(
    outcomeRiskRows.map((row) => [row.outcomeId, {
      betCount: Number(row.betCount ?? 0),
      totalStake: parseStoredNonNegativeMoney(row.totalStake ?? '0'),
      totalPotentialPayout: parseStoredNonNegativeMoney(row.totalPotentialPayout ?? '0'),
    }]),
  );
  const totalMarketStake = [...rowByOutcome.values()].reduce((sum, row) => sum + row.totalStake, 0n);

  return {
    marketId: market.id,
    question: market.question,
    status: market.status,
    outcomes: [...(market.outcomes ?? [])]
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((outcome) => {
        const row = rowByOutcome.get(outcome.id) ?? {
          betCount: 0,
          totalStake: 0n,
          totalPotentialPayout: 0n,
        };

        return {
          outcomeId: outcome.id,
          name: outcome.name,
          betCount: row.betCount,
          totalStake: moneyToString(row.totalStake),
          totalPotentialPayout: moneyToString(row.totalPotentialPayout),
          netPnLIfOutcomeWins: moneyToString(totalMarketStake - row.totalPotentialPayout),
        };
      }),
  };
}

export async function getAdminMarketRiskSummary({ db, marketId }) {
  const market = await db.market.findUnique({
    where: { id: marketId },
    include: { outcomes: true },
  });

  if (!market) {
    throw new BetPlacementError('MARKET_NOT_FOUND', 'Market does not exist.');
  }

  const outcomeRiskRows = await db.$queryRaw`
    SELECT
      "outcomeId",
      COUNT(*)::int AS "betCount",
      COALESCE(SUM("stake"), 0)::text AS "totalStake",
      COALESCE(SUM("potentialPayout"), 0)::text AS "totalPotentialPayout"
    FROM "Bet"
    WHERE "marketId" = ${marketId}::uuid
      AND "status" = 'OPEN'
    GROUP BY "outcomeId"
  `;

  return buildMarketRiskSummary({ market, outcomeRiskRows });
}

function parseStoredNonNegativeMoney(value) {
  const raw = String(value).trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(raw)) {
    throw new BetPlacementError('INVALID_STORED_MONEY', 'Stored monetary value is invalid.');
  }
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole) * MONEY_FACTOR + BigInt(fraction.padEnd(Number(MONEY_SCALE), '0'));
}

export async function placeBet({ db, user, request, limits = null, now = new Date() }) {
  assertCanPlaceBet(user);
  const betRequest = normalizeBetRequest(request);

  return db.$transaction(async (tx) => {
    const systemConfig = await loadSystemConfigForBetting({ tx });
    assertGlobalBettingActive(systemConfig);
    const activeLimits = limits ?? systemConfig.limits;

    const wallet = await lockWalletForUpdate(tx, user.id);
    if (parseStoredNonNegativeMoney(wallet.availableBalance) < parseMoney(betRequest.stake)) {
      throw new WalletError('INSUFFICIENT_FUNDS', 'Available balance cannot become negative.');
    }

    const rows = await tx.$queryRaw`
      SELECT
        o."id" AS "outcomeId",
        o."marketId",
        o."odds",
        o."status" AS "outcomeStatus",
        m."eventId",
        m."status" AS "marketStatus",
        m."closesAt"
      FROM "Outcome" o
      JOIN "Market" m ON m."id" = o."marketId"
      WHERE o."id" = ${betRequest.outcomeId}::uuid
        AND o."marketId" = ${betRequest.marketId}::uuid
      FOR UPDATE OF o, m
    `;
    const outcome = Array.isArray(rows) ? rows[0] : rows;

    if (!outcome) {
      throw new BetPlacementError('OUTCOME_NOT_FOUND', 'Outcome does not exist for market.');
    }

    if (!canMarketAcceptNewBet({ status: outcome.marketStatus, closesAt: outcome.closesAt }, now)) {
      if (outcome.marketStatus === 'OPEN') {
        throw new BetPlacementError('MARKET_CLOSED_BY_TIME', 'Market is closed by server time.');
      }
      throw new BetPlacementError('MARKET_NOT_OPEN', 'Market is not open.');
    }

    if (outcome.outcomeStatus !== 'ACTIVE') {
      throw new BetPlacementError('OUTCOME_NOT_ACTIVE', 'Outcome is not active.');
    }

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${betRequest.marketId}))`;

    const oddsSnapshot = decimalOddsToString(parseDecimalOdds(outcome.odds));
    const potentialPayout = calculatePotentialPayout(betRequest.stake, oddsSnapshot);

    const liabilityRows = await tx.$queryRaw`
      SELECT
        "outcomeId",
        COUNT(*)::int AS "betCount",
        COALESCE(SUM("stake"), 0)::text AS "totalStake",
        COALESCE(SUM("potentialPayout"), 0)::text AS "totalPotentialPayout"
      FROM "Bet"
      WHERE "marketId" = ${betRequest.marketId}::uuid
        AND "status" = 'OPEN'
      GROUP BY "outcomeId"
    `;
    const userExposureRows = await tx.$queryRaw`
      SELECT COALESCE(SUM("stake"), 0)::text AS "totalOpenStake"
      FROM "Bet"
      WHERE "userId" = ${user.id}::uuid
        AND "status" = 'OPEN'
    `;
    const currentUserOpenStake = (Array.isArray(userExposureRows) ? userExposureRows[0] : userExposureRows)?.totalOpenStake ?? '0';

    validateBetLimits({ stake: betRequest.stake, potentialPayout, currentUserOpenStake, limits: activeLimits });
    validateMarketLiability({
      currentOutcomePayouts: liabilityRows,
      outcomeId: betRequest.outcomeId,
      newPotentialPayout: potentialPayout,
      limits: activeLimits,
    });

    await allowWalletMutationInCurrentTransaction(tx);

    const betId = randomUUID();
    const { wallet: updatedWallet, ledger } = await createLedgerBackedBalanceChange({
      tx,
      wallet,
      type: LEDGER_ENTRY_TYPES.BET_STAKE,
      direction: LEDGER_DIRECTIONS.DEBIT,
      amount: betRequest.stake,
      referenceType: 'Bet',
      referenceId: betId,
      idempotencyKey: `bet-stake:${betId}`,
      metadata: {
        marketId: betRequest.marketId,
        outcomeId: betRequest.outcomeId,
        oddsSnapshot,
        potentialPayout,
      },
    });

    const bet = await tx.bet.create({
      data: {
        id: betId,
        userId: user.id,
        eventId: outcome.eventId,
        marketId: betRequest.marketId,
        outcomeId: betRequest.outcomeId,
        idempotencyKey: randomUUID(),
        stake: betRequest.stake,
        oddsSnapshot,
        potentialPayout,
        status: 'OPEN',
      },
    });

    return {
      bet,
      wallet: updatedWallet,
      ledger,
    };
  });
}
