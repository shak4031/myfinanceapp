import { randomBytes } from 'node:crypto';
import { administrativeTransaction } from '../db.js';
import { recordAudit, structuredLog } from './audit.js';
import { isDemoEmail } from './demo.js';
import { sendSecurityNotice } from './mailer.js';
import { tokenHash } from './passwords.js';
import { OWNER_USER_ID } from './license.js';
import { removeAccountRecords } from './accountDeletion.js';

export const UNVERIFIED_DELETE_DAYS = 15;
export const UNVERIFIED_WARNING_DAYS = 3;
const DAY_MS = 86400000;
const UNVERIFIED = `u.role='user' AND u.id<>${OWNER_USER_ID} AND u.password_hash IS NOT NULL AND u.email_verified_at IS NULL`;

// Emails a fresh verification link to accounts that will be removed in UNVERIFIED_WARNING_DAYS.
export async function sendUnverifiedWarnings(now = new Date()) {
  const cutoff = new Date(now.getTime() - (UNVERIFIED_DELETE_DAYS - UNVERIFIED_WARNING_DAYS) * DAY_MS);
  return administrativeTransaction(async client => {
    const due = (await client.query(`SELECT u.id,u.name,u.email,u.created_at FROM users u
      WHERE ${UNVERIFIED} AND u.created_at<=$1 AND u.unverified_warning_sent_at IS NULL
      ORDER BY u.created_at LIMIT 100 FOR UPDATE OF u SKIP LOCKED`, [cutoff])).rows.filter(user => !isDemoEmail(user.email));
    for (const user of due) {
      const token = randomBytes(32).toString('hex');
      await client.query('DELETE FROM email_verification_tokens WHERE user_id=$1', [user.id]);
      await client.query(`INSERT INTO email_verification_tokens(token_hash,user_id,expires_at)
        VALUES($1,$2,$3::timestamptz + ($4 * INTERVAL '1 day'))`, [tokenHash(token), user.id, now, UNVERIFIED_WARNING_DAYS]);
      const sent = await sendSecurityNotice(user, 'Verify your MyFinance email to keep your account',
        `Hi ${user.name},\n\nYour MyFinance email is still unverified. Unverified accounts are deleted ${UNVERIFIED_DELETE_DAYS} days after signup, `
        + `so this account and anything saved in it will be removed in ${UNVERIFIED_WARNING_DAYS} days.\n\n`
        + `Verify now to keep it:\n${process.env.APP_ORIGIN || ''}/#verify-token=${token}\n\nIf you did not create this login, ignore this email and it will be removed automatically.`);
      if (!sent) throw new Error('Unverified-account warning email is not configured');
      await client.query('UPDATE users SET unverified_warning_sent_at=$2 WHERE id=$1', [user.id, now]);
    }
    return due.length;
  });
}

// Deletes accounts still unverified UNVERIFIED_DELETE_DAYS after signup, only once the warning has had its full notice period.
export async function deleteUnverifiedAccounts(now = new Date()) {
  const created = new Date(now.getTime() - UNVERIFIED_DELETE_DAYS * DAY_MS);
  const warned = new Date(now.getTime() - UNVERIFIED_WARNING_DAYS * DAY_MS);
  const ids = await administrativeTransaction(async client => (await client.query(`SELECT u.id FROM users u
    WHERE ${UNVERIFIED} AND u.created_at<=$1 AND u.unverified_warning_sent_at<=$2 ORDER BY u.created_at LIMIT 100`,
  [created, warned])).rows.map(row => row.id));
  let deleted = 0;
  for (const id of ids) {
    const outcome = await administrativeTransaction(async client => {
      const target = (await client.query(`SELECT u.id,u.email,u.created_at,m.role AS household_role,m.household_id,
          (SELECT COUNT(*)::int FROM household_members members WHERE members.household_id=m.household_id) AS household_members,
          s.stripe_customer_id,s.stripe_subscription_id,
          EXISTS(SELECT 1 FROM plaid_connections p WHERE p.user_id=u.id) AS bank_connected
        FROM users u LEFT JOIN household_members m ON m.user_id=u.id
        LEFT JOIN household_subscriptions s ON s.household_id=m.household_id
        WHERE u.id=$1 AND ${UNVERIFIED} AND u.created_at<=$2 AND u.unverified_warning_sent_at<=$3
        FOR UPDATE OF u SKIP LOCKED`, [id, created, warned])).rows[0];
      if (!target || isDemoEmail(target.email)) return null;
      // Leave anything with billing, a live bank link or other members for an administrator to review.
      const skip = target.stripe_customer_id || target.stripe_subscription_id ? 'billing_record'
        : target.bank_connected ? 'bank_connection'
        : target.household_role === 'owner' && Number(target.household_members) > 1 ? 'household_members' : null;
      if (skip) return { skip, target };
      return { target, counts: await removeAccountRecords(client, target) };
    });
    if (!outcome) continue;
    if (outcome.skip) {
      structuredLog('warn', { event: 'account.unverified_cleanup_skipped', userId: outcome.target.id, reason: outcome.skip });
      continue;
    }
    deleted += 1;
    await recordAudit(null, 'account.unverified_deleted', 'success', {
      subjectUserId: outcome.target.id, email: outcome.target.email,
      detail: { reason: 'email_unverified', days: UNVERIFIED_DELETE_DAYS, removedRecords: outcome.counts }
    });
  }
  return deleted;
}

export function startUnverifiedCleanup() {
  const run = async () => {
    try {
      await sendUnverifiedWarnings();
      await deleteUnverifiedAccounts();
    } catch (error) {
      structuredLog('error', { event: 'account.unverified_cleanup_failed', message: error.message });
    }
  };
  run();
  return setInterval(run, 60 * 60 * 1000).unref();
}
