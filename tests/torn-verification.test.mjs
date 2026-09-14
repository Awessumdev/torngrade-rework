import assert from 'node:assert/strict';
import {
  signTornCallbackBody,
  verifyTornApiIdentity,
  verifyTornAuthRequest,
  verifyTornCallbackSignature,
} from '../src/auth/torn-verification.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function headers(values = {}) {
  return {
    get(name) {
      return values[name.toLowerCase()] ?? null;
    },
  };
}

test('verifies Torn API key by loading owner profile from Torn API', async () => {
  const calls = [];
  const identity = await verifyTornApiIdentity({
    apiKey: 'abc12345',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        json: async () => ({ player_id: 12345, name: 'RealUser' }),
      };
    },
    baseUrl: 'https://api.torn.test/v2/user',
  });

  assert.deepEqual(identity, { externalTornId: '12345', username: 'RealUser' });
  assert.match(calls[0].url, /selections=profile/);
  assert.match(calls[0].url, /key=abc12345/);
  assert.equal(calls[0].options.cache, 'no-store');
});

test('rejects unsigned spoofed Torn identity without API verification', async () => {
  await assert.rejects(
    () => verifyTornAuthRequest({
      rawBody: JSON.stringify({ externalTornId: '12345', username: 'Spoof' }),
      headers: headers(),
      fetchImpl: async () => {
        throw new Error('fetch should not run');
      },
    }),
    (error) => error.code === 'TORN_VERIFICATION_REQUIRED',
  );
});

test('accepts Torn auth request after server-side API verification', async () => {
  const identity = await verifyTornAuthRequest({
    rawBody: JSON.stringify({ apiKey: 'validKey123' }),
    headers: headers(),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ player_id: 98765, name: 'ApiUser' }),
    }),
  });

  assert.deepEqual(identity, { externalTornId: '98765', username: 'ApiUser' });
});

test('verifies signed callback payload and rejects replay or tampering', () => {
  const rawBody = JSON.stringify({ externalTornId: '12345', username: 'SignedUser' });
  const timestamp = String(Date.parse('2026-09-14T12:00:00.000Z'));
  const secret = 'callback-secret';
  const signature = signTornCallbackBody({ rawBody, timestamp, secret });

  assert.doesNotThrow(() => verifyTornCallbackSignature({
    rawBody,
    timestamp,
    signature,
    secret,
    now: new Date('2026-09-14T12:01:00.000Z'),
  }));

  assert.throws(
    () => verifyTornCallbackSignature({
      rawBody: `${rawBody} `,
      timestamp,
      signature,
      secret,
      now: new Date('2026-09-14T12:01:00.000Z'),
    }),
    (error) => error.code === 'TORN_CALLBACK_SIGNATURE_INVALID',
  );

  assert.throws(
    () => verifyTornCallbackSignature({
      rawBody,
      timestamp,
      signature,
      secret,
      now: new Date('2026-09-14T12:06:00.001Z'),
    }),
    (error) => error.code === 'TORN_CALLBACK_REPLAY_REJECTED',
  );
});

test('signed Torn callback can authenticate without exposing API key', async () => {
  const rawBody = JSON.stringify({ externalTornId: '12345', username: 'SignedUser' });
  const timestamp = String(Date.parse('2026-09-14T12:00:00.000Z'));
  const secret = 'callback-secret';
  const signature = signTornCallbackBody({ rawBody, timestamp, secret });

  const identity = await verifyTornAuthRequest({
    rawBody,
    headers: headers({
      'x-torn-signature': signature,
      'x-torn-timestamp': timestamp,
    }),
    callbackSecret: secret,
    now: new Date('2026-09-14T12:01:00.000Z'),
  });

  assert.deepEqual(identity, { externalTornId: '12345', username: 'SignedUser' });
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
