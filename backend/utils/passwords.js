import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, options);
  return `scrypt:${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, salt, hex] = String(encoded || '').split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(hex || '')) return false;
  const key = await scrypt(password, salt, 64, options);
  return timingSafeEqual(key, Buffer.from(hex, 'hex'));
}

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function validCredentials(email, password) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && typeof password === 'string' && password.length >= 12 && password.length <= 128;
}
