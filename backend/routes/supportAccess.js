import { Router } from 'express';
import { administrativeTransaction } from '../db.js';
import { recordAudit } from '../utils/audit.js';

const router = Router();
const MAX_ACTIVE_GRANTS = 3;

const grantView = row => ({
  id: row.id, accessLevel: row.access_level, reason: row.reason, createdAt: row.created_at,
  expiresAt: row.expires_at, revokedAt: row.revoked_at, lastUsedAt: row.last_used_at,
  active: !row.revoked_at && new Date(row.expires_at) > new Date()
});

// Customers see their own grants and every support action taken on their account.
router.get('/', async (req, res, next) => {
  try {
    const data = await administrativeTransaction(async client => {
      const grants = (await client.query(
        'SELECT * FROM support_grants WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id])).rows;
      const activity = (await client.query(`
        SELECT a.created_at, a.event_type, a.outcome, a.method, a.path, a.status, a.support_grant_id, u.name AS actor_name
        FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.subject_user_id = $1 AND (a.support_grant_id IS NOT NULL OR a.event_type LIKE 'support.%')
        ORDER BY a.created_at DESC LIMIT 200
      `, [req.user.id])).rows;
      return { grants: grants.map(grantView), activity };
    });
    res.json(data);
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const accessLevel = req.body?.accessLevel === 'write' ? 'write' : 'read';
    const hours = Number(req.body?.hours ?? 24);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) return res.status(400).json({ error: 'Access can last from 1 to 72 hours' });
    if (reason.length < 5 || reason.length > 300) return res.status(400).json({ error: 'Describe the issue support is helping with (5 to 300 characters)' });
    const grant = await administrativeTransaction(async client => {
      const active = (await client.query(
        'SELECT COUNT(*)::int AS count FROM support_grants WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > NOW()', [req.user.id])).rows[0].count;
      if (active >= MAX_ACTIVE_GRANTS) return null;
      return (await client.query(`
        INSERT INTO support_grants (user_id, access_level, reason, expires_at)
        VALUES ($1,$2,$3,NOW() + make_interval(hours => $4)) RETURNING *
      `, [req.user.id, accessLevel, reason, hours])).rows[0];
    });
    if (!grant) return res.status(409).json({ error: `You can have at most ${MAX_ACTIVE_GRANTS} active support grants. Revoke one first.` });
    await recordAudit(req, 'support.grant_created', 'success', {
      supportGrantId: grant.id, status: 200, detail: { accessLevel, hours, reason } });
    res.json(grantView(grant));
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: 'Grant not found' });
    const grant = await administrativeTransaction(async client => {
      const row = (await client.query(`
        UPDATE support_grants SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE id=$1 AND user_id=$2 RETURNING *
      `, [id, req.user.id])).rows[0];
      if (row) await client.query('DELETE FROM sessions WHERE support_grant_id=$1', [id]);
      return row;
    });
    if (!grant) return res.status(404).json({ error: 'Grant not found' });
    await recordAudit(req, 'support.grant_revoked', 'success', { supportGrantId: id, status: 200 });
    res.json(grantView(grant));
  } catch (error) { next(error); }
});

export default router;
