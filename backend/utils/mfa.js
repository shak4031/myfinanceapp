import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { tokenHash } from './passwords.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const MFA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_mfa (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_ciphertext TEXT, pending_ciphertext TEXT, pending_expires_at TIMESTAMPTZ,
    last_step BIGINT NOT NULL DEFAULT -1,
    recovery_hashes TEXT[] NOT NULL DEFAULT '{}', enabled_at TIMESTAMPTZ
  );
`;

function key() {
  const encoded = process.env.MFA_ENCRYPTION_KEY || '';
  const value = Buffer.from(encoded, 'base64');
  if (value.length !== 32 || value.toString('base64') !== encoded) {
    throw Object.assign(new Error('Authenticator verification requires a configured MFA_ENCRYPTION_KEY.'), { status: 503, code: 'MFA_KEY_UNAVAILABLE' });
  }
  return value;
}

export function newSecret() {
  let bits = 0, value = 0, text = '';
  for (const byte of randomBytes(20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; text += alphabet[(value >>> bits) & 31]; }
  }
  return text;
}

function secretBytes(secret) {
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of secret) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('Invalid authenticator secret');
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  return Buffer.from(bytes);
}

export function totp(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secretBytes(secret)).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

export function matchingStep(secret, code, lastStep = -1, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const step of [current, current - 1, current + 1]) {
    if (step >= 0 && step > Number(lastStep) && timingSafeEqual(Buffer.from(code), Buffer.from(totp(secret, step)))) return step;
  }
  return null;
}

export function encryptSecret(secret, userId) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(`myfinance-mfa:${userId}`));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(value => value.toString('base64')).join(':');
}

export function decryptSecret(encoded, userId) {
  const [iv, tag, ciphertext] = encoded.split(':').map(value => Buffer.from(value, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(`myfinance-mfa:${userId}`));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8');
}

export function recoveryCodes() {
  const codes = Array.from({ length: 10 }, () => randomBytes(16).toString('hex'));
  return { codes, hashes: codes.map(tokenHash) };
}

// Caller holds the user row lock to serialize sign-ins and enrollment changes.
export async function consumeFactor(client, row, code) {
  if (!row?.enabled_at) return false;
  if (typeof code === 'string' && /^[a-f0-9]{32}$/i.test(code.trim())) {
    const hash = tokenHash(code.trim().toLowerCase());
    const result = await client.query(`UPDATE user_mfa SET recovery_hashes=array_remove(recovery_hashes,$2)
      WHERE user_id=$1 AND $2=ANY(recovery_hashes) RETURNING user_id`, [row.user_id, hash]);
    return result.rows.length === 1;
  }
  const step = matchingStep(decryptSecret(row.secret_ciphertext, row.user_id), code, row.last_step);
  if (step === null) return false;
  await client.query('UPDATE user_mfa SET last_step=$2 WHERE user_id=$1', [row.user_id, step]);
  return true;
}
