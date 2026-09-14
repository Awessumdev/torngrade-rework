import assert from 'node:assert/strict';
import {
  ADMIN_ROLES,
  ADMIN_STATUS,
  AuthorizationError,
  USER_STATUS,
  WHITELIST_STATUS,
  addUserToWhitelist,
  assertCanAccessProduction,
  assertCanLoginClosedBeta,
  assertCanPlaceBet,
  authenticateTornIdentity,
  normalizeTornIdentity,
  removeUserFromWhitelist,
} from '../src/auth/authorization.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const activeWhitelistedUser = {
  id: 'user-1',
  status: USER_STATUS.ACTIVE,
  whitelistEntries: [{ status: WHITELIST_STATUS.ACTIVE }],
};

const whitelistAdmin = {
  id: 'admin-1',
  status: ADMIN_STATUS.ACTIVE,
  roles: [ADMIN_ROLES.WHITELIST_MANAGER],
};

test('normalizes Torn identity for server-side auth', () => {
  assert.deepEqual(
    normalizeTornIdentity({ id: 12345, username: 'RealUser' }),
    { externalTornId: '12345', username: 'RealUser' },
  );

  assert.throws(
    () => normalizeTornIdentity({ id: '0', username: 'RealUser' }),
    (error) => error instanceof AuthorizationError && error.code === 'INVALID_TORN_IDENTITY',
  );
});

test('production login requires active user but no whitelist gate', () => {
  assert.doesNotThrow(() => assertCanLoginClosedBeta(activeWhitelistedUser));
  assert.doesNotThrow(() => assertCanAccessProduction({ id: 'user-2', status: USER_STATUS.ACTIVE, whitelistEntries: [] }));

  assert.throws(
    () => assertCanLoginClosedBeta({ ...activeWhitelistedUser, status: USER_STATUS.SUSPENDED }),
    (error) => error.code === 'USER_NOT_ACTIVE',
  );
});

test('bet placement authorization follows production user status gate', () => {
  assert.doesNotThrow(() => assertCanPlaceBet(activeWhitelistedUser));
  assert.doesNotThrow(() => assertCanPlaceBet({ id: 'user-3', status: USER_STATUS.ACTIVE, whitelistEntries: [] }));
});

test('authenticateTornIdentity upserts by external Torn id and accepts active production users', async () => {
  const db = {
    user: {
      upsert: async (args) => {
        assert.equal(args.where.externalTornId, '12345');
        assert.equal(args.create.username, 'RealUser');
        assert.equal(args.update.username, 'RealUser');
        assert.equal(args.include, undefined);
        return { id: 'user-1', status: USER_STATUS.ACTIVE, whitelistEntries: [] };
      },
    },
  };

  const result = await authenticateTornIdentity({ db, tornIdentity: { externalTornId: '12345', username: 'RealUser' } });
  assert.equal(result.id, 'user-1');
});

test('only active whitelist admins can add users to closed beta whitelist', async () => {
  await assert.rejects(
    () => addUserToWhitelist({
      db: {},
      admin: { id: 'admin-2', status: ADMIN_STATUS.ACTIVE, roles: [ADMIN_ROLES.AUDITOR] },
      userId: 'user-1',
    }),
    (error) => error.code === 'ADMIN_FORBIDDEN',
  );
});

test('admin add whitelist writes entry and audit in one transaction', async () => {
  const calls = [];
  const db = {
    $transaction: async (fn) => fn({
      user: {
        findUnique: async () => ({ id: 'user-1', status: USER_STATUS.ACTIVE }),
      },
      whitelistEntry: {
        findFirst: async () => null,
        create: async ({ data }) => {
          calls.push(['createWhitelist', data]);
          return { id: 'wl-1', ...data };
        },
      },
      auditLog: {
        create: async ({ data }) => calls.push(['audit', data]),
      },
    }),
  };

  const entry = await addUserToWhitelist({
    db,
    admin: whitelistAdmin,
    userId: 'user-1',
    reason: 'closed beta approved',
  });

  assert.equal(entry.status, WHITELIST_STATUS.ACTIVE);
  assert.equal(calls[0][0], 'createWhitelist');
  assert.equal(calls[1][1].action, 'WHITELIST_ADD');
});

test('admin remove whitelist marks active entry removed and writes audit', async () => {
  const calls = [];
  const db = {
    $transaction: async (fn) => fn({
      whitelistEntry: {
        findFirst: async () => ({ id: 'wl-1', userId: 'user-1', status: WHITELIST_STATUS.ACTIVE }),
        update: async ({ data }) => {
          calls.push(['removeWhitelist', data]);
          return { id: 'wl-1', ...data };
        },
      },
      auditLog: {
        create: async ({ data }) => calls.push(['audit', data]),
      },
    }),
  };

  const removed = await removeUserFromWhitelist({ db, admin: whitelistAdmin, userId: 'user-1' });

  assert.equal(removed.status, WHITELIST_STATUS.REMOVED);
  assert.ok(removed.removedAt instanceof Date);
  assert.equal(calls[1][1].action, 'WHITELIST_REMOVE');
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
