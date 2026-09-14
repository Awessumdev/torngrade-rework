import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeTornIdentity } from './authorization.mjs';

export class TornVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TornVerificationError';
    this.code = code;
  }
}

const DEFAULT_TORN_USER_URL = 'https://api.torn.com/v2/user';
const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export function parseTornAuthBody(rawBody) {
  try {
    const body = JSON.parse(rawBody || '{}');
    if (!body || typeof body !== 'object') {
      throw new Error('not object');
    }
    return body;
  } catch {
    throw new TornVerificationError('INVALID_TORN_AUTH_JSON', 'Torn auth payload must be valid JSON.');
  }
}

export function signTornCallbackBody({ rawBody, timestamp, secret }) {
  if (!secret) {
    throw new TornVerificationError('TORN_CALLBACK_SECRET_MISSING', 'Torn callback secret is not configured.');
  }
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

export function verifyTornCallbackSignature({
  rawBody,
  timestamp,
  signature,
  secret,
  now = new Date(),
  toleranceMs = DEFAULT_SIGNATURE_TOLERANCE_MS,
}) {
  if (!secret) {
    throw new TornVerificationError('TORN_CALLBACK_SECRET_MISSING', 'Torn callback secret is not configured.');
  }

  if (!timestamp || !signature) {
    throw new TornVerificationError('TORN_CALLBACK_SIGNATURE_REQUIRED', 'Torn callback signature and timestamp are required.');
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs)) {
    throw new TornVerificationError('TORN_CALLBACK_TIMESTAMP_INVALID', 'Torn callback timestamp is invalid.');
  }

  if (Math.abs(now.getTime() - timestampMs) > toleranceMs) {
    throw new TornVerificationError('TORN_CALLBACK_REPLAY_REJECTED', 'Torn callback timestamp is outside the replay window.');
  }

  const expected = signTornCallbackBody({ rawBody, timestamp, secret });
  const actualBuffer = Buffer.from(String(signature), 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new TornVerificationError('TORN_CALLBACK_SIGNATURE_INVALID', 'Torn callback signature is invalid.');
  }

  return true;
}

export function extractTornApiKey(body) {
  const apiKey = String(body.apiKey ?? body.tornApiKey ?? '').trim();
  if (!apiKey) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(apiKey)) {
    throw new TornVerificationError('TORN_API_KEY_INVALID', 'Torn API key format is invalid.');
  }
  return apiKey;
}

export async function verifyTornApiIdentity({
  apiKey,
  fetchImpl = globalThis.fetch,
  baseUrl = process.env.TORN_API_USER_URL ?? DEFAULT_TORN_USER_URL,
}) {
  if (!apiKey) {
    throw new TornVerificationError('TORN_API_KEY_REQUIRED', 'Torn API key is required.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TornVerificationError('TORN_FETCH_UNAVAILABLE', 'Server fetch is unavailable.');
  }

  const url = new URL(baseUrl);
  url.searchParams.set('selections', 'profile');
  url.searchParams.set('key', apiKey);

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new TornVerificationError('TORN_API_REJECTED', 'Torn API rejected the supplied key.');
  }

  const payload = await response.json();
  if (payload.error) {
    throw new TornVerificationError('TORN_API_REJECTED', 'Torn API rejected the supplied key.');
  }

  return normalizeTornApiProfile(payload);
}

export function normalizeTornApiProfile(payload) {
  const id = payload.player_id ?? payload.id ?? payload.userID ?? payload.user_id;
  const username = payload.name ?? payload.playername ?? payload.username;
  return normalizeTornIdentity({ id, username });
}

export async function verifyTornAuthRequest({
  rawBody,
  headers,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  requireSignature = process.env.TORN_AUTH_REQUIRE_SIGNATURE === 'true',
  callbackSecret = process.env.TORN_CALLBACK_SECRET,
}) {
  const body = parseTornAuthBody(rawBody);
  const signature = headers.get('x-torn-signature');
  const timestamp = headers.get('x-torn-timestamp');
  const hasSignature = Boolean(signature || timestamp);
  const apiKey = extractTornApiKey(body);

  if (apiKey) {
    if (hasSignature) {
      verifyTornCallbackSignature({
        rawBody,
        timestamp,
        signature,
        secret: callbackSecret,
        now,
      });
    }
    return verifyTornApiIdentity({ apiKey, fetchImpl });
  }

  if (requireSignature || hasSignature) {
    verifyTornCallbackSignature({
      rawBody,
      timestamp,
      signature,
      secret: callbackSecret,
      now,
    });
  }

  if (hasSignature) {
    return normalizeTornIdentity(body.tornIdentity ?? body);
  }

  throw new TornVerificationError('TORN_VERIFICATION_REQUIRED', 'Torn API key or signed Torn callback is required.');
}
