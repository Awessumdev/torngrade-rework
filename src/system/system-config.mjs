import { assertAdminCanManageMarkets } from '../auth/authorization.mjs';
import { moneyToString, parseMoney } from '../wallet/wallet-service.mjs';

export const GLOBAL_BETTING_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
});

export const SYSTEM_CONFIG_KEY = 'production';

export const DEFAULT_PRODUCTION_BET_LIMITS = Object.freeze({
  minBet: '1',
  maxBet: '5',
  maxPayoutPerBet: '25',
  maxMarketLiability: '100',
  maxUserOpenExposure: '25',
});

export class SystemConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SystemConfigError';
    this.code = code;
  }
}

export function normalizeBetLimits(input = DEFAULT_PRODUCTION_BET_LIMITS) {
  const limits = {
    minBet: moneyToString(parseMoney(input.minBet ?? DEFAULT_PRODUCTION_BET_LIMITS.minBet)),
    maxBet: moneyToString(parseMoney(input.maxBet ?? DEFAULT_PRODUCTION_BET_LIMITS.maxBet)),
    maxPayoutPerBet: moneyToString(parseMoney(input.maxPayoutPerBet ?? DEFAULT_PRODUCTION_BET_LIMITS.maxPayoutPerBet)),
    maxMarketLiability: moneyToString(parseMoney(input.maxMarketLiability ?? DEFAULT_PRODUCTION_BET_LIMITS.maxMarketLiability)),
    maxUserOpenExposure: moneyToString(parseMoney(input.maxUserOpenExposure ?? DEFAULT_PRODUCTION_BET_LIMITS.maxUserOpenExposure)),
  };

  if (parseMoney(limits.minBet) > parseMoney(limits.maxBet)) {
    throw new SystemConfigError('INVALID_BET_LIMITS', 'Minimum bet cannot exceed maximum bet.');
  }

  if (parseMoney(limits.maxBet) > parseMoney(limits.maxPayoutPerBet)) {
    throw new SystemConfigError('INVALID_BET_LIMITS', 'Maximum payout must cover maximum bet.');
  }

  if (parseMoney(limits.maxPayoutPerBet) > parseMoney(limits.maxMarketLiability)) {
    throw new SystemConfigError('INVALID_BET_LIMITS', 'Market liability must cover maximum payout per bet.');
  }

  return limits;
}

export function normalizeSystemConfig(config) {
  const globalBettingStatus = config?.globalBettingStatus ?? GLOBAL_BETTING_STATUS.ACTIVE;
  if (!Object.values(GLOBAL_BETTING_STATUS).includes(globalBettingStatus)) {
    throw new SystemConfigError('INVALID_GLOBAL_BETTING_STATUS', 'Global betting status is invalid.');
  }

  return {
    key: config?.key ?? SYSTEM_CONFIG_KEY,
    globalBettingStatus,
    limits: normalizeBetLimits(config?.betLimits ?? config?.limits ?? DEFAULT_PRODUCTION_BET_LIMITS),
  };
}

export async function loadSystemConfigForBetting({ tx }) {
  if (tx?.$queryRaw) {
    const rows = await tx.$queryRaw`
      SELECT
        "key",
        "globalBettingStatus",
        "betLimits"
      FROM "SystemConfig"
      WHERE "key" = ${SYSTEM_CONFIG_KEY}
      FOR UPDATE
    `;
    const row = Array.isArray(rows) ? rows[0] : rows;
    return normalizeSystemConfig(row);
  }

  return normalizeSystemConfig();
}

export function assertGlobalBettingActive(config) {
  if (config.globalBettingStatus !== GLOBAL_BETTING_STATUS.ACTIVE) {
    throw new SystemConfigError('GLOBAL_BETTING_SUSPENDED', 'Global betting is suspended.');
  }
}

export async function updateBettingRiskLimits({ db, admin, limits, now = new Date() }) {
  assertAdminCanManageMarkets(admin);
  const normalizedLimits = normalizeBetLimits(limits);

  return db.$transaction(async (tx) => {
    const currentRows = await tx.$queryRaw`
      SELECT * FROM "SystemConfig"
      WHERE "key" = ${SYSTEM_CONFIG_KEY}
      FOR UPDATE
    `;
    const current = Array.isArray(currentRows) ? currentRows[0] : currentRows;

    const config = current
      ? await tx.systemConfig.update({
        where: { key: SYSTEM_CONFIG_KEY },
        data: {
          betLimits: normalizedLimits,
          updatedByAdminId: admin.id,
          updatedAt: now,
        },
      })
      : await tx.systemConfig.create({
        data: {
          key: SYSTEM_CONFIG_KEY,
          globalBettingStatus: GLOBAL_BETTING_STATUS.ACTIVE,
          betLimits: normalizedLimits,
          updatedByAdminId: admin.id,
          updatedAt: now,
        },
      });

    await tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorAdminId: admin.id,
        action: 'BETTING_RISK_LIMITS_UPDATED',
        resourceType: 'SystemConfig',
        resourceId: null,
        before: current ? { betLimits: current.betLimits } : null,
        after: { betLimits: normalizedLimits },
      },
    });

    return normalizeSystemConfig(config);
  });
}

export async function setGlobalBettingStatus({ db, admin = null, status, reason = null, now = new Date() }) {
  if (admin) {
    assertAdminCanManageMarkets(admin);
  }
  if (!Object.values(GLOBAL_BETTING_STATUS).includes(status)) {
    throw new SystemConfigError('INVALID_GLOBAL_BETTING_STATUS', 'Global betting status is invalid.');
  }

  return db.$transaction(async (tx) => {
    const currentRows = await tx.$queryRaw`
      SELECT * FROM "SystemConfig"
      WHERE "key" = ${SYSTEM_CONFIG_KEY}
      FOR UPDATE
    `;
    const current = Array.isArray(currentRows) ? currentRows[0] : currentRows;
    const beforeStatus = current?.globalBettingStatus ?? GLOBAL_BETTING_STATUS.ACTIVE;

    const config = current
      ? await tx.systemConfig.update({
        where: { key: SYSTEM_CONFIG_KEY },
        data: {
          globalBettingStatus: status,
          updatedByAdminId: admin?.id ?? current.updatedByAdminId ?? null,
          updatedAt: now,
        },
      })
      : await tx.systemConfig.create({
        data: {
          key: SYSTEM_CONFIG_KEY,
          globalBettingStatus: status,
          betLimits: DEFAULT_PRODUCTION_BET_LIMITS,
          updatedByAdminId: admin?.id ?? null,
          updatedAt: now,
        },
      });

    await tx.auditLog.create({
      data: {
        actorType: admin ? 'ADMIN' : 'SYSTEM',
        actorAdminId: admin?.id ?? null,
        action: 'GLOBAL_BETTING_STATUS_CHANGED',
        resourceType: 'SystemConfig',
        resourceId: null,
        before: { globalBettingStatus: beforeStatus },
        after: { globalBettingStatus: status },
        metadata: { reason },
      },
    });

    return normalizeSystemConfig(config);
  });
}

export async function suspendGlobalBettingInTransaction({ tx, reason = null, now = new Date() }) {
  const currentRows = await tx.$queryRaw`
    SELECT * FROM "SystemConfig"
    WHERE "key" = ${SYSTEM_CONFIG_KEY}
    FOR UPDATE
  `;
  const current = Array.isArray(currentRows) ? currentRows[0] : currentRows;

  if (current?.globalBettingStatus === GLOBAL_BETTING_STATUS.SUSPENDED) {
    return normalizeSystemConfig(current);
  }

  const config = current
    ? await tx.systemConfig.update({
      where: { key: SYSTEM_CONFIG_KEY },
      data: {
        globalBettingStatus: GLOBAL_BETTING_STATUS.SUSPENDED,
        updatedAt: now,
      },
    })
    : await tx.systemConfig.create({
      data: {
        key: SYSTEM_CONFIG_KEY,
        globalBettingStatus: GLOBAL_BETTING_STATUS.SUSPENDED,
        betLimits: DEFAULT_PRODUCTION_BET_LIMITS,
        updatedAt: now,
      },
    });

  await tx.auditLog.create({
    data: {
      actorType: 'SYSTEM',
      action: 'GLOBAL_BETTING_STATUS_CHANGED',
      resourceType: 'SystemConfig',
      resourceId: null,
      before: { globalBettingStatus: current?.globalBettingStatus ?? GLOBAL_BETTING_STATUS.ACTIVE },
      after: { globalBettingStatus: GLOBAL_BETTING_STATUS.SUSPENDED },
      metadata: { reason },
    },
  });

  return normalizeSystemConfig(config);
}
