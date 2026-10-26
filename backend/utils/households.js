import { randomBytes } from 'node:crypto';
import { tokenHash } from './passwords.js';
import { failure } from './categorization.js';
import { isDemoEmail } from './demo.js';

// Financial user_id remains the immutable tenant key of the household's original owner.
// Login identity is separate and is never accepted as a tenant selector from the client.
export async function ensureHousehold(client, userId) {
  const existing = await membership(client, userId);
  if (existing) return existing;
  await client.query(`INSERT INTO households(owner_user_id,name) SELECT id,name || '''s household' FROM users
    WHERE id=$1 ON CONFLICT(owner_user_id) DO NOTHING`, [userId]);
  await client.query(`INSERT INTO household_members(user_id,household_id,role)
    SELECT $1,id,'owner' FROM households WHERE owner_user_id=$1 ON CONFLICT(user_id) DO NOTHING`, [userId]);
  return membership(client, userId);
}

export async function membership(client, userId) {
  return (await client.query(`SELECT h.id,h.name,h.owner_user_id,m.role FROM household_members m
    JOIN households h ON h.id=m.household_id WHERE m.user_id=$1`, [userId])).rows[0];
}

export function ownerOnly(req) {
  if (req.support || req.household?.role !== 'owner') throw failure(403, 'Only the household owner can manage membership and billing.');
  if (isDemoEmail(req.user?.email)) throw failure(403, 'Household membership and billing cannot be changed in the public demo.');
}

export async function createInvitation(client, household, email, actorId) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw failure(400, 'Provide a valid invitation email.');
  await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [household.id]);
  const throttle = tokenHash(`household-invite:${household.id}`);
  await client.query('DELETE FROM auth_attempts WHERE key=$1 AND reset_at<NOW()', [throttle]);
  const attempts = (await client.query(`INSERT INTO auth_attempts(key,attempts,reset_at) VALUES($1,1,NOW()+INTERVAL '1 hour')
    ON CONFLICT(key) DO UPDATE SET attempts=auth_attempts.attempts+1 RETURNING attempts`, [throttle])).rows[0].attempts;
  if (attempts > 10) throw failure(429, 'Too many invitations. Try again in an hour.');
  const count = (await client.query('SELECT COUNT(*)::int AS count FROM household_members WHERE household_id=$1', [household.id])).rows[0].count;
  const pending = (await client.query('SELECT COUNT(*)::int AS count FROM household_invitations WHERE household_id=$1 AND expires_at>NOW() AND used_at IS NULL', [household.id])).rows[0].count;
  if (count + pending >= 10) throw failure(409, 'A household supports up to ten members and pending invitations.');
  const member = (await client.query(`SELECT 1 FROM household_members m JOIN users u ON u.id=m.user_id
    WHERE m.household_id=$1 AND lower(u.email)=$2`, [household.id, email])).rows[0];
  if (member) throw failure(409, 'This person is already a household member.');
  const token = randomBytes(32).toString('hex');
  await client.query(`DELETE FROM household_invitations WHERE household_id=$1 AND email=$2 AND used_at IS NULL`, [household.id, email]);
  const invite = (await client.query(`INSERT INTO household_invitations(household_id,email,token_hash,invited_by,expires_at)
    VALUES($1,$2,$3,$4,NOW()+INTERVAL '48 hours') RETURNING id,email,expires_at`,
  [household.id, email, tokenHash(token), actorId])).rows[0];
  return { token, invite };
}

export async function invitedHousehold(client, token, email) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw failure(400, 'A valid invitation is required.');
  const invitation = (await client.query(`SELECT i.*,h.owner_user_id FROM household_invitations i
    JOIN households h ON h.id=i.household_id
    WHERE i.token_hash=$1 AND i.email=$2 AND i.expires_at>NOW() AND i.used_at IS NULL FOR UPDATE OF i`,
  [tokenHash(token), email])).rows[0];
  if (!invitation) throw failure(409, 'The invitation expired, was revoked, or does not match this email.');
  await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [invitation.household_id]);
  return invitation;
}

export async function joinHousehold(client, invitation, userId) {
  const count = (await client.query('SELECT COUNT(*)::int AS count FROM household_members WHERE household_id=$1',
    [invitation.household_id])).rows[0].count;
  if (count >= 10) throw failure(409, 'This household has reached its ten-member limit.');
  await client.query("INSERT INTO household_members(user_id,household_id,role) VALUES($1,$2,'member')", [userId, invitation.household_id]);
  await client.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at,NOW()) WHERE id=$1', [userId]);
  await client.query('UPDATE household_invitations SET used_at=NOW() WHERE id=$1', [invitation.id]);
  await client.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
}
