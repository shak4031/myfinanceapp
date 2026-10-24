import { Router } from 'express';
import { administrativeTransaction } from '../db.js';
import { currentUserId } from '../utils/tenant.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const userId = currentUserId();
    const result = await administrativeTransaction(async client => {
      const total = Number((await client.query(
        'SELECT COUNT(*)::int AS count FROM audit_events WHERE subject_user_id=$1', [userId])).rows[0].count);
      const events = (await client.query(`SELECT a.id,a.created_at,a.event_type,a.outcome,a.actor_user_id,
        actor.name AS actor_name,a.request_id,a.path,a.status,a.detail
        FROM audit_events a LEFT JOIN users actor ON actor.id=a.actor_user_id
        WHERE a.subject_user_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset])).rows;
      return { events, total };
    });
    res.json({ ...result, limit, offset });
  } catch (error) {
    next(error);
  }
});

export default router;
