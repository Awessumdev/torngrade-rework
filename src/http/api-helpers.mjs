import { NextResponse } from 'next/server';
import { prisma } from './prisma.mjs';
import { ADMIN_ROLES } from '../auth/authorization.mjs';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const PUBLIC_ERROR_STATUS = Object.freeze({
  USER_NOT_FOUND: 401,
  USER_NOT_ACTIVE: 403,
  ADMIN_UNAUTHENTICATED: 401,
  ADMIN_FORBIDDEN: 403,
  CLIENT_FIELD_NOT_ALLOWED: 400,
  INVALID_BET_REQUEST: 400,
  INVALID_TORN_IDENTITY: 400,
  INVALID_TORN_USERNAME: 400,
  INVALID_WITHDRAWAL_REQUEST: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  SETTLEMENT_CONFIRMATION_REQUIRED: 400,
  SETTLEMENT_CONFIRMATION_MISMATCH: 409,
  INSUFFICIENT_FUNDS: 409,
  GLOBAL_BETTING_SUSPENDED: 423,
  MARKET_NOT_OPEN: 409,
  MARKET_CLOSED_BY_TIME: 409,
  MARKET_LIABILITY_LIMIT_EXCEEDED: 409,
  USER_OPEN_EXPOSURE_LIMIT_EXCEEDED: 409,
  PAYOUT_ABOVE_MAX: 409,
  STAKE_ABOVE_MAX: 400,
  STAKE_BELOW_MIN: 400,
  INSUFFICIENT_SETTLEMENT_LIQUIDITY: 409,
  BET_NOT_FOUND: 404,
  MARKET_NOT_FOUND: 404,
  OUTCOME_NOT_FOUND: 404,
  WITHDRAWAL_NOT_FOUND: 404,
  DEPOSIT_NOT_VERIFIED: 400,
  INVALID_EXTERNAL_TRANSACTION_ID: 400,
});

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
}

export function json(data, init = {}) {
  return NextResponse.json(data, {
    status: init.status ?? 200,
    headers: {
      'Cache-Control': 'no-store',
      ...(init.headers ?? {}),
    },
  });
}

export function noStoreHeaders() {
  return {
    'Cache-Control': 'no-store',
  };
}

export async function handleApi(handler) {
  try {
    return await handler();
  } catch (error) {
    const status = error.status ?? PUBLIC_ERROR_STATUS[error.code] ?? 500;
    const code = error.code ?? 'INTERNAL_SERVER_ERROR';
    const message = status === 500 ? 'Internal server error.' : error.message;

    if (status === 500) {
      console.error(error);
    }

    return json({ error: { code, message } }, { status });
  }
}

export async function requireUser(request, db = prisma) {
  const userId = request.headers.get('x-user-id');
  if (!userId) {
    throw new ApiError(401, 'USER_NOT_FOUND', 'Authenticated user is required.');
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    include: { wallet: true },
  });

  if (!user) {
    throw new ApiError(401, 'USER_NOT_FOUND', 'Authenticated user is required.');
  }

  return user;
}

export async function requireAdmin(request, db = prisma) {
  const adminId = request.headers.get('x-admin-id');
  if (!adminId) {
    throw new ApiError(401, 'ADMIN_UNAUTHENTICATED', 'Authenticated admin is required.');
  }

  const admin = await db.adminUser.findUnique({ where: { id: adminId } });
  if (!admin) {
    throw new ApiError(401, 'ADMIN_UNAUTHENTICATED', 'Authenticated admin is required.');
  }

  return admin;
}

export function requireSystemSecret(request) {
  const expected = process.env.INTERNAL_API_SECRET;
  const provided = request.headers.get('x-internal-secret');

  if (!expected || provided !== expected) {
    throw new ApiError(401, 'SYSTEM_UNAUTHENTICATED', 'Valid internal API secret is required.');
  }
}

export function parseTake(searchParams, fallback = 50) {
  const raw = searchParams.get('take');
  if (!raw) return fallback;
  const take = Number(raw);
  if (!Number.isInteger(take) || take < 1 || take > 100) {
    throw new ApiError(400, 'INVALID_TAKE', 'take must be an integer from 1 to 100.');
  }
  return take;
}

export function adminBootstrapRoles() {
  return Object.values(ADMIN_ROLES);
}
