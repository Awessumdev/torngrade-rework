import { assertAdminCanManageMarkets } from '../auth/authorization.mjs';

export const MARKET_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
  SETTLING: 'SETTLING',
  SETTLED: 'SETTLED',
  VOID: 'VOID',
});

export class MarketLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketLifecycleError';
    this.code = code;
  }
}

const ALLOWED_TRANSITIONS = Object.freeze({
  [MARKET_STATUSES.DRAFT]: new Set([MARKET_STATUSES.OPEN, MARKET_STATUSES.VOID]),
  [MARKET_STATUSES.OPEN]: new Set([MARKET_STATUSES.SUSPENDED, MARKET_STATUSES.CLOSED, MARKET_STATUSES.VOID]),
  [MARKET_STATUSES.SUSPENDED]: new Set([MARKET_STATUSES.OPEN, MARKET_STATUSES.VOID]),
  [MARKET_STATUSES.CLOSED]: new Set([MARKET_STATUSES.SETTLING, MARKET_STATUSES.VOID]),
  [MARKET_STATUSES.SETTLING]: new Set([MARKET_STATUSES.SETTLED, MARKET_STATUSES.VOID]),
  [MARKET_STATUSES.SETTLED]: new Set([]),
  [MARKET_STATUSES.VOID]: new Set([]),
});

export function assertMarketTransitionAllowed(fromStatus, toStatus) {
  if (!Object.values(MARKET_STATUSES).includes(toStatus)) {
    throw new MarketLifecycleError('UNKNOWN_MARKET_STATUS', 'Target market status is unknown.');
  }

  if (!ALLOWED_TRANSITIONS[fromStatus]?.has(toStatus)) {
    throw new MarketLifecycleError(
      'INVALID_MARKET_TRANSITION',
      `Market cannot transition from ${fromStatus} to ${toStatus}.`,
    );
  }
}

export function canMarketAcceptNewBet({ status, closesAt }, now = new Date()) {
  return status === MARKET_STATUSES.OPEN && new Date(closesAt).getTime() > now.getTime();
}

export async function transitionMarketStatus({ db, admin, marketId, toStatus, reason = null, now = new Date() }) {
  assertAdminCanManageMarkets(admin);

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT * FROM "Market"
      WHERE "id" = ${marketId}::uuid
      FOR UPDATE
    `;
    const market = Array.isArray(rows) ? rows[0] : rows;

    if (!market) {
      throw new MarketLifecycleError('MARKET_NOT_FOUND', 'Market does not exist.');
    }

    assertMarketTransitionAllowed(market.status, toStatus);

    const data = { status: toStatus };
    if (toStatus === MARKET_STATUSES.SETTLED || toStatus === MARKET_STATUSES.VOID) {
      data.settledAt = now;
    }

    const updatedMarket = await tx.market.update({
      where: { id: marketId },
      data,
    });

    await tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorAdminId: admin.id,
        action: 'MARKET_STATUS_TRANSITION',
        resourceType: 'Market',
        resourceId: marketId,
        before: { status: market.status },
        after: { status: toStatus },
        metadata: { reason },
      },
    });

    return updatedMarket;
  });
}

export function openMarket(args) {
  return transitionMarketStatus({ ...args, toStatus: MARKET_STATUSES.OPEN });
}

export function suspendMarket(args) {
  return transitionMarketStatus({ ...args, toStatus: MARKET_STATUSES.SUSPENDED });
}

export function closeMarket(args) {
  return transitionMarketStatus({ ...args, toStatus: MARKET_STATUSES.CLOSED });
}

export function startSettlingMarket(args) {
  return transitionMarketStatus({ ...args, toStatus: MARKET_STATUSES.SETTLING });
}

export function markMarketSettled(args) {
  return transitionMarketStatus({ ...args, toStatus: MARKET_STATUSES.SETTLED });
}

export function voidMarket(args) {
  return transitionMarketStatus({ ...args, toStatus: MARKET_STATUSES.VOID });
}
