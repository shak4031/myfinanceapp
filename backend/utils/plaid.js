import { createDecipheriv, createCipheriv, createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

const webhookKeys = new Map();
const KEY_TTL_MS = 60 * 60 * 1000;
const ALLOWED_ENVIRONMENTS = {
  sandbox: PlaidEnvironments.sandbox,
  production: PlaidEnvironments.production
};

function encryptionKey() {
  const encoded = process.env.PLAID_TOKEN_ENCRYPTION_KEY || '';
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    const error = new Error('Plaid token encryption is not configured correctly');
    error.status = 503;
    throw error;
  }
  return key;
}

export function encryptPlaidToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptPlaidToken(value) {
  const [version, iv, tag, ciphertext] = String(value || '').split(':');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Stored Plaid token has an invalid format');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

export function getPlaidClient() {
  const environment = String(process.env.PLAID_ENVIRONMENT || 'sandbox').toLowerCase();
  const basePath = ALLOWED_ENVIRONMENTS[environment];
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET || !basePath) {
    const error = new Error('Plaid is not configured. Set PLAID_CLIENT_ID, PLAID_SECRET, and a valid PLAID_ENVIRONMENT.');
    error.status = 503;
    throw error;
  }
  return new PlaidApi(new Configuration({
    basePath,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET
      }
    }
  }));
}

export function plaidErrorCode(error) {
  return error?.response?.data?.error_code || error?.response?.data?.error?.error_code || null;
}

function decodeJwtPart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Malformed webhook signature');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function getWebhookKey(plaidClient, keyId) {
  const cached = webhookKeys.get(keyId);
  if (cached && cached.expiresAt > Date.now()) return cached.key;
  const response = await plaidClient.webhookVerificationKeyGet({ key_id: keyId });
  const key = response.data.key;
  if (!key || key.alg !== 'ES256' || key.use !== 'sig' || key.kty !== 'EC' || key.crv !== 'P-256') {
    throw new Error('Plaid returned an invalid webhook verification key');
  }
  webhookKeys.set(keyId, { key, expiresAt: Date.now() + KEY_TTL_MS });
  return key;
}

export async function verifyPlaidWebhook(rawBody, signature, plaidClient = getPlaidClient()) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string') return false;
  const parts = signature.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = decodeJwtPart(parts[0]);
    const claims = decodeJwtPart(parts[1]);
    if (header.alg !== 'ES256' || !/^[0-9a-f-]{36}$/i.test(header.kid)
      || !Number.isInteger(claims.iat) || Math.abs(Date.now() / 1000 - claims.iat) > 300
      || typeof claims.request_body_sha256 !== 'string') return false;
    const key = await getWebhookKey(plaidClient, header.kid);
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
    const validSignature = verify('sha256', signingInput,
      {
        key: createPublicKey({
          key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
          format: 'jwk'
        }),
        dsaEncoding: 'ieee-p1363'
      },
      Buffer.from(parts[2], 'base64url'));
    if (!validSignature) return false;
    const actualHash = createHash('sha256').update(rawBody).digest();
    const claimedHash = Buffer.from(claims.request_body_sha256, 'hex');
    return claimedHash.length === actualHash.length && timingSafeEqual(claimedHash, actualHash);
  } catch (error) {
    if (error?.response) throw error;
    return false;
  }
}
