import { handleApi, json } from '../../../src/http/api-helpers.mjs';
import { prisma } from '../../../src/http/prisma.mjs';

export async function GET() {
  return handleApi(async () => {
    const events = await prisma.event.findMany({
      where: {
        markets: {
          some: { status: { in: ['OPEN', 'SUSPENDED'] } },
        },
      },
      include: {
        markets: {
          where: { status: { in: ['OPEN', 'SUSPENDED'] } },
          include: {
            outcomes: {
              where: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
              orderBy: { sortOrder: 'asc' },
            },
          },
          orderBy: { closesAt: 'asc' },
        },
      },
      orderBy: { startsAt: 'asc' },
    });

    return json({
      events: events.map((event) => ({
        ...event,
        markets: event.markets.map((market) => ({
          ...market,
          outcomes: market.outcomes.map((outcome) => ({
            ...outcome,
            odds: String(outcome.odds),
          })),
        })),
      })),
    });
  });
}
