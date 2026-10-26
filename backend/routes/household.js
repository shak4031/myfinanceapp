import { Router } from 'express';
import { administrativeTransaction } from '../db.js';
import { ownerOnly, createInvitation, invitedHousehold, joinHousehold, ensureHousehold } from '../utils/households.js';
import { PRIVATE_TABLES, DEFAULT_CATEGORIES } from '../utils/schema.js';
import { failure } from '../utils/categorization.js';
import { sendSecurityNotice, mailConfigured, appOrigin } from '../utils/mailer.js';
import { recordAudit } from '../utils/audit.js';

const router = Router();
const route = handler => async (req, res, next) => {
  try {
    if (req.support) throw failure(403, 'End support access to manage household membership.');
    await handler(req, res);
  } catch (error) { next(error); }
};

router.get('/', route(async (req, res) => {
  const data = await administrativeTransaction(async client => ({
    members: (await client.query(`SELECT u.id,u.name,u.email,m.role FROM household_members m
      JOIN users u ON u.id=m.user_id WHERE m.household_id=$1 ORDER BY m.role DESC,u.id`, [req.household.id])).rows,
    invitations: req.household.role === 'owner' ? (await client.query(`SELECT id,email,expires_at FROM household_invitations
      WHERE household_id=$1 AND used_at IS NULL AND expires_at>NOW() ORDER BY id DESC`, [req.household.id])).rows : []
  }));
  res.json({ id: req.household.id, name: req.household.name, owner: req.household.role === 'owner', ...data });
}));

router.post('/invitations', route(async (req, res) => {
  ownerOnly(req);
  if (!mailConfigured()) throw failure(503, 'Invitation email delivery is not configured. Contact the administrator.');
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const invite = await administrativeTransaction(async client => {
    const result = await createInvitation(client, req.household, email, req.user.id);
    const sent = await sendSecurityNotice({ email }, 'Invitation to your MyFinance household',
      `${req.user.name} invited you to share their financial household. Members can view and edit all household finances, but cannot manage billing or members.\n\nAccept within 48 hours:\n${appOrigin(req)}/#invite-token=${result.token}\n\nUse your own login and password. Ignore this email if you were not expecting it.`);
    if (!sent) throw failure(503, 'The invitation could not be emailed. Nothing was changed.');
    return result.invite;
  });
  await recordAudit(req, 'household.invited', 'success', { detail: { invitationId: invite.id } });
  res.status(201).json({ invitation: invite });
}));

router.delete('/invitations/:id', route(async (req, res) => {
  ownerOnly(req);
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw failure(400, 'Invalid invitation.');
  const result = await administrativeTransaction(client => client.query(`DELETE FROM household_invitations
    WHERE id=$1 AND household_id=$2 AND used_at IS NULL RETURNING id`, [id, req.household.id]));
  if (!result.rows.length) throw failure(404, 'Invitation not found.');
  await recordAudit(req, 'household.invitation_revoked', 'success', { detail: { invitationId: id } });
  res.json({ success: true });
}));

router.delete('/members/:id', route(async (req, res) => {
  ownerOnly(req);
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || id === req.household.owner_user_id) throw failure(400, 'The household owner cannot be removed.');
  await administrativeTransaction(async client => {
    await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [req.household.id]);
    const removed = await client.query(`DELETE FROM household_members WHERE user_id=$1 AND household_id=$2 AND role='member' RETURNING user_id`,
      [id, req.household.id]);
    if (!removed.rows.length) throw failure(404, 'Member not found.');
    await client.query('DELETE FROM sessions WHERE user_id=$1 OR actor_user_id=$1', [id]);
    await client.query('UPDATE support_grants SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
    await ensureHousehold(client, id);
  });
  await recordAudit(req, 'household.member_removed', 'success', { detail: { memberId: id } });
  res.json({ success: true });
}));

router.post('/accept', route(async (req, res) => {
  const result = await administrativeTransaction(async client => {
    const invite = await invitedHousehold(client, req.body?.token, req.user.email);
    const prior = req.household;
    if (prior.id === invite.household_id) throw failure(409, 'You already belong to this household.');
    await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [prior.id]);
    const members = (await client.query('SELECT COUNT(*)::int AS count FROM household_members WHERE household_id=$1', [prior.id])).rows[0].count;
    if (prior.role !== 'owner' || members !== 1) throw failure(409, 'Leave your current shared household before accepting another invitation.');
    const paid = (await client.query(`SELECT 1 FROM household_subscriptions WHERE household_id=$1
      AND (stripe_customer_id IS NOT NULL OR trial_used)
      UNION ALL SELECT 1 FROM user_licenses WHERE user_id=$2 AND (granted_at IS NOT NULL OR trial_started_at IS NOT NULL)`,
    [prior.id, req.user.id])).rows;
    if (req.user.id === 1 || req.user.role === 'admin' || paid.length) throw failure(409, 'An existing paid or administrative household cannot be merged.');
    const categories = (await client.query('SELECT name,icon,color FROM categories WHERE user_id=$1', [req.user.id])).rows;
    if (categories.some(category => !DEFAULT_CATEGORIES.some(([name, icon, color]) =>
      category.name === name && category.icon === icon && category.color === color))) {
      throw failure(409, 'Your household has customized categories. Automatic merging is not supported.');
    }
    // Seeded default categories are harmless. All other financial history must be explicitly retained separately.
    for (const table of PRIVATE_TABLES.filter(table => table !== 'categories')) {
      const row = (await client.query(`SELECT 1 FROM ${table} WHERE user_id=$1 LIMIT 1`, [req.user.id])).rows[0];
      if (row) throw failure(409, 'Your household already has financial data. Joining would hide that data; automatic merging is not supported.');
    }
    await client.query('DELETE FROM household_members WHERE user_id=$1', [req.user.id]);
    await client.query('DELETE FROM households WHERE id=$1', [prior.id]);
    await joinHousehold(client, invite, req.user.id);
    return { success: true, signInRequired: true };
  });
  await recordAudit(req, 'household.invite_accepted', 'success');
  res.json(result);
}));

export default router;
