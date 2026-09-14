import { assertCanAccessProduction } from '../auth/authorization.mjs';

export class UserBetViewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UserBetViewError';
    this.code = code;
  }
}

export const USER_VISIBLE_BET_STATUSES = Object.freeze(['OPEN', 'WON', 'LOST', 'VOID']);

const BET_INCLUDE = Object.freeze({
  event: true,
  market: true,
  outcome: true,
});

export function serializeUserBet(bet) {
  return {
    id: bet.id,
    event: {
      id: bet.event.id,
      title: bet.event.title,
      slug: bet.event.slug,
    },
    market: {
      id: bet.market.id,
      question: bet.market.question,
    },
    outcome: {
      id: bet.outcome.id,
      name: bet.outcome.name,
    },
    stake: String(bet.stake),
    oddsSnapshot: String(bet.oddsSnapshot),
    potentialPayout: String(bet.potentialPayout),
    status: bet.status,
    placedAt: bet.placedAt,
    settledAt: bet.settledAt,
  };
}

export async function listUserBets({ db, user, status, take = 50, cursor = null }) {
  assertCanAccessProduction(user);

  if (status && !USER_VISIBLE_BET_STATUSES.includes(status)) {
    throw new UserBetViewError('INVALID_BET_STATUS_FILTER', 'Bet status filter is invalid.');
  }

  const bets = await db.bet.findMany({
    where: {
      userId: user.id,
      status: status ? { equals: status } : { in: [...USER_VISIBLE_BET_STATUSES] },
    },
    include: BET_INCLUDE,
    orderBy: { placedAt: 'desc' },
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  return bets.map(serializeUserBet);
}

export async function getUserBetDetail({ db, user, betId }) {
  assertCanAccessProduction(user);

  const bet = await db.bet.findFirst({
    where: {
      id: betId,
      userId: user.id,
      status: { in: [...USER_VISIBLE_BET_STATUSES] },
    },
    include: BET_INCLUDE,
  });

  if (!bet) {
    throw new UserBetViewError('BET_NOT_FOUND', 'Bet does not exist for this user.');
  }

  return serializeUserBet(bet);
}
