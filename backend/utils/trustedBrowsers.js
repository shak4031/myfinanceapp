import { randomBytes } from 'node:crypto';
import { tokenHash } from './passwords.js';

export const TRUST_DAYS = 90;
export const TRUSTED_BROWSER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS trusted_browsers (
    id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS trusted_browsers_user_idx ON trusted_browsers(user_id,expires_at);
`;

// The caller locks the user row; rotation and revocation serialize with MFA/password changes.
export async function rememberBrowser(client, userId, previous) {
  const existing = previous && (await client.query(`SELECT id,expires_at FROM trusted_browsers
    WHERE user_id=$1 AND token_hash=$2 AND expires_at>NOW()`,
  [userId, tokenHash(previous)])).rows[0];
  const token = randomBytes(32).toString('hex');
  const row = existing
    ? (await client.query('UPDATE trusted_browsers SET token_hash=$2,last_used_at=NOW() WHERE id=$1 RETURNING expires_at', [existing.id, tokenHash(token)])).rows[0]
    : (await client.query(`INSERT INTO trusted_browsers(user_id,token_hash,expires_at)
      VALUES($1,$2,NOW()+INTERVAL '90 days') RETURNING expires_at`, [userId, tokenHash(token)])).rows[0];
  await client.query(`DELETE FROM trusted_browsers WHERE user_id=$1 AND
    (expires_at<=NOW() OR id IN (SELECT id FROM trusted_browsers WHERE user_id=$1 ORDER BY id DESC OFFSET 20))`, [userId]);
  return { token, expiresAt: row.expires_at };
}

export async function browserIsTrusted(client, userId, token) {
  if (!token) return false;
  return (await client.query(`SELECT id FROM trusted_browsers
    WHERE user_id=$1 AND token_hash=$2 AND expires_at>NOW()`, [userId, tokenHash(token)])).rows.length === 1;
}

export async function revokeTrustedBrowsers(client, userId) {
  await client.query('DELETE FROM trusted_browsers WHERE user_id=$1', [userId]);
}
