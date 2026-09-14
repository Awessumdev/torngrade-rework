export const USER_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
});

export const ADMIN_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
});

export const WHITELIST_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  REMOVED: 'REMOVED',
});

export const ADMIN_ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  WHITELIST_MANAGER: 'WHITELIST_MANAGER',
  MARKET_MANAGER: 'MARKET_MANAGER',
  MARKET_SETTLER: 'MARKET_SETTLER',
  PAYMENTS_REVIEWER: 'PAYMENTS_REVIEWER',
  PAYMENTS_APPROVER: 'PAYMENTS_APPROVER',
  AUDITOR: 'AUDITOR',
});

export class AuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

export function normalizeTornIdentity(identity) {
  if (!identity || typeof identity !== 'object') {
    throw new AuthorizationError('INVALID_TORN_IDENTITY', 'Torn identity is required.');
  }

  const externalTornId = String(identity.externalTornId ?? identity.id ?? '').trim();
  const username = String(identity.username ?? '').trim();

  if (!/^[1-9][0-9]*$/.test(externalTornId)) {
    throw new AuthorizationError('INVALID_TORN_IDENTITY', 'Torn identity id must be a positive numeric string.');
  }

  if (username.length < 2 || username.length > 32) {
    throw new AuthorizationError('INVALID_TORN_USERNAME', 'Torn username length is invalid.');
  }

  return { externalTornId, username };
}

export function isAdminAllowed(admin, requiredRole) {
  if (!admin || admin.status !== ADMIN_STATUS.ACTIVE) {
    return false;
  }

  const roles = new Set(admin.roles ?? []);
  return roles.has(ADMIN_ROLES.SUPER_ADMIN) || roles.has(requiredRole);
}

export function assertAdminCanManageWhitelist(admin) {
  if (!isAdminAllowed(admin, ADMIN_ROLES.WHITELIST_MANAGER)) {
    throw new AuthorizationError('ADMIN_FORBIDDEN', 'Admin is not allowed to manage whitelist.');
  }
}

export function assertAdminCanManageMarkets(admin) {
  if (!isAdminAllowed(admin, ADMIN_ROLES.MARKET_MANAGER)) {
    throw new AuthorizationError('ADMIN_FORBIDDEN', 'Admin is not allowed to manage markets.');
  }
}

export function assertAdminCanSettleMarkets(admin) {
  if (!isAdminAllowed(admin, ADMIN_ROLES.MARKET_SETTLER)) {
    throw new AuthorizationError('ADMIN_FORBIDDEN', 'Admin is not allowed to settle markets.');
  }
}

export function assertAdminCanViewDashboard(admin) {
  if (!isAdminAllowed(admin, ADMIN_ROLES.AUDITOR)) {
    throw new AuthorizationError('ADMIN_FORBIDDEN', 'Admin is not allowed to view admin dashboard.');
  }
}

export function hasActiveWhitelist(user) {
  return (user?.whitelistEntries ?? []).some((entry) => entry.status === WHITELIST_STATUS.ACTIVE);
}

export function assertCanAccessProduction(user) {
  if (!user) {
    throw new AuthorizationError('USER_NOT_FOUND', 'User does not exist.');
  }

  if (user.status !== USER_STATUS.ACTIVE) {
    throw new AuthorizationError('USER_NOT_ACTIVE', 'User is not active.');
  }
}

export function assertCanLoginClosedBeta(user) {
  assertCanAccessProduction(user);
}

export function assertCanPlaceBet(user) {
  assertCanAccessProduction(user);
}

export async function authenticateTornIdentity({ db, tornIdentity }) {
  const identity = normalizeTornIdentity(tornIdentity);

  const user = await db.user.upsert({
    where: { externalTornId: identity.externalTornId },
    create: {
      externalTornId: identity.externalTornId,
      username: identity.username,
    },
    update: {
      username: identity.username,
    },
  });

  assertCanAccessProduction(user);
  return user;
}

export async function addUserToWhitelist({ db, admin, userId, reason = null }) {
  assertAdminCanManageWhitelist(admin);

  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });

    if (!user) {
      throw new AuthorizationError('USER_NOT_FOUND', 'User does not exist.');
    }

    if (user.status === USER_STATUS.CLOSED) {
      throw new AuthorizationError('USER_CLOSED', 'Closed users cannot be whitelisted.');
    }

    const activeEntry = await tx.whitelistEntry.findFirst({
      where: { userId, status: WHITELIST_STATUS.ACTIVE },
    });

    const entry = activeEntry
      ? await tx.whitelistEntry.update({
        where: { id: activeEntry.id },
        data: {
          reason,
          addedByAdminId: admin.id,
        },
      })
      : await tx.whitelistEntry.create({
        data: {
        userId,
        status: WHITELIST_STATUS.ACTIVE,
        reason,
        addedByAdminId: admin.id,
        },
      });

    await tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorAdminId: admin.id,
        action: 'WHITELIST_ADD',
        resourceType: 'User',
        resourceId: userId,
        after: { status: WHITELIST_STATUS.ACTIVE, reason },
      },
    });

    return entry;
  });
}

export async function removeUserFromWhitelist({ db, admin, userId }) {
  assertAdminCanManageWhitelist(admin);

  return db.$transaction(async (tx) => {
    const activeEntry = await tx.whitelistEntry.findFirst({
      where: { userId, status: WHITELIST_STATUS.ACTIVE },
    });

    if (!activeEntry) {
      return null;
    }

    const removed = await tx.whitelistEntry.update({
      where: { id: activeEntry.id },
      data: {
        status: WHITELIST_STATUS.REMOVED,
        removedByAdminId: admin.id,
        removedAt: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorAdminId: admin.id,
        action: 'WHITELIST_REMOVE',
        resourceType: 'User',
        resourceId: userId,
        before: { status: WHITELIST_STATUS.ACTIVE },
        after: { status: WHITELIST_STATUS.REMOVED },
      },
    });

    return removed;
  });
}
