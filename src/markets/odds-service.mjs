import { assertAdminCanManageMarkets } from '../auth/authorization.mjs';

export class OddsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OddsError';
    this.code = code;
  }
}

const DECIMAL_SCALE = 8n;
const DECIMAL_FACTOR = 10n ** DECIMAL_SCALE;
const PROBABILITY_SCALE = 6;

export function parseDecimalOdds(value) {
  const raw = String(value).trim();

  if (!/^(1|[2-9]\d*|1\.\d*[1-9]\d*|[2-9]\d*\.\d{1,8})$/.test(raw)) {
    throw new OddsError('INVALID_DECIMAL_ODDS', 'Decimal odds must be greater than 1 with up to 8 fractional digits.');
  }

  const [whole, fraction = ''] = raw.split('.');
  const scaled = BigInt(whole) * DECIMAL_FACTOR + BigInt(fraction.padEnd(Number(DECIMAL_SCALE), '0'));

  if (scaled <= DECIMAL_FACTOR) {
    throw new OddsError('INVALID_DECIMAL_ODDS', 'Decimal odds must be greater than 1.');
  }

  return scaled;
}

export function decimalOddsToString(scaledOdds) {
  const whole = scaledOdds / DECIMAL_FACTOR;
  const fraction = String(scaledOdds % DECIMAL_FACTOR).padStart(Number(DECIMAL_SCALE), '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

export function impliedProbability(decimalOdds) {
  const scaledOdds = parseDecimalOdds(decimalOdds);
  const probability = Number(DECIMAL_FACTOR) / Number(scaledOdds);
  return Number(probability.toFixed(PROBABILITY_SCALE));
}

export function buildMarketOddsSummary(market) {
  const outcomes = [...(market.outcomes ?? [])]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((outcome) => ({
      id: outcome.id,
      name: outcome.name,
      currentOdds: decimalOddsToString(parseDecimalOdds(outcome.odds)),
      impliedProbability: impliedProbability(outcome.odds),
      status: outcome.status,
      sortOrder: outcome.sortOrder,
    }));

  const totalMarketOverround = Number(
    outcomes.reduce((sum, outcome) => sum + outcome.impliedProbability, 0).toFixed(PROBABILITY_SCALE),
  );

  return {
    marketId: market.id,
    question: market.question,
    status: market.status,
    outcomes,
    totalMarketOverround,
  };
}

export async function getAdminMarketOddsSummary({ db, marketId }) {
  const market = await db.market.findUnique({
    where: { id: marketId },
    include: { outcomes: true },
  });

  if (!market) {
    throw new OddsError('MARKET_NOT_FOUND', 'Market does not exist.');
  }

  return buildMarketOddsSummary(market);
}

export async function updateOpenMarketOutcomeOdds({ db, admin, outcomeId, newOdds, reason = null }) {
  assertAdminCanManageMarkets(admin);
  const normalizedOdds = decimalOddsToString(parseDecimalOdds(newOdds));

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT o.*, m."status" AS "marketStatus", m."id" AS "lockedMarketId"
      FROM "Outcome" o
      JOIN "Market" m ON m."id" = o."marketId"
      WHERE o."id" = ${outcomeId}::uuid
      FOR UPDATE OF o, m
    `;
    const lockedOutcome = Array.isArray(rows) ? rows[0] : rows;

    if (!lockedOutcome) {
      throw new OddsError('OUTCOME_NOT_FOUND', 'Outcome does not exist.');
    }

    if (lockedOutcome.marketStatus !== 'OPEN') {
      throw new OddsError('MARKET_NOT_OPEN', 'Only OPEN market odds can be changed.');
    }

    const previousOdds = decimalOddsToString(parseDecimalOdds(lockedOutcome.odds));

    if (previousOdds === normalizedOdds) {
      return {
        outcome: lockedOutcome,
        previousOdds,
        newOdds: normalizedOdds,
        changed: false,
      };
    }

    const updatedOutcome = await tx.outcome.update({
      where: { id: outcomeId },
      data: { odds: normalizedOdds },
    });

    await tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorAdminId: admin.id,
        action: 'OUTCOME_ODDS_UPDATE',
        resourceType: 'Outcome',
        resourceId: outcomeId,
        before: {
          odds: previousOdds,
          impliedProbability: impliedProbability(previousOdds),
        },
        after: {
          odds: normalizedOdds,
          impliedProbability: impliedProbability(normalizedOdds),
        },
        metadata: {
          marketId: lockedOutcome.lockedMarketId,
          reason,
        },
      },
    });

    return {
      outcome: updatedOutcome,
      previousOdds,
      newOdds: normalizedOdds,
      changed: true,
    };
  });
}
