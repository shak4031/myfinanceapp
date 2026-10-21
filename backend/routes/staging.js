import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';
import { parseTxDate } from '../utils/normalize.js';

const router = Router();
const db = new Database();
const reviewable = ['duplicate', 'error', 'excluded'];
const validId = id => /^[1-9]\d*$/.test(String(id)) && Number.isSafeInteger(Number(id));

// GET /api/staging/attention - List items that were skipped or had errors
router.get('/attention', async (req, res) => {
  try {
    const items = await db.all(
      "SELECT * FROM staging_transactions WHERE status IN ('duplicate', 'error', 'excluded') ORDER BY created_at DESC"
    );
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staging/force-push - Manually push a skipped item to production
router.post('/force-push', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!validId(id)) return res.status(400).json({ error: 'Choose a valid queued record.' });
    const result = await db.transaction(async client => {
      const st = (await client.query('SELECT * FROM staging_transactions WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!st) return { status: 404, error: 'Queued record not found.' };
      if (!reviewable.includes(st.status)) return { status: 409, error: 'This queued record has already been processed.' };
      const date = parseTxDate(st.date)?.iso;
      const timestamp = date ? Date.parse(`${date}T00:00:00Z`) : NaN;
      const direction = String(st.direction || '').toUpperCase();
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date
        || !st.description?.trim() || st.amount == null || !Number.isFinite(Number(st.amount))
        || Number(st.amount) <= 0 || !['DEBIT', 'CREDIT'].includes(direction)) {
        return { status: 422, error: 'This record has invalid transaction details. Import a corrected source file instead.' };
      }
      // A legacy record has no account identity. Keep it unassigned for explicit review.
      await client.query(
        `INSERT INTO transactions (date, description, amount, direction, balance, source, category)
         VALUES ($1, $2, $3, $4, $5, $6, 'Other')`,
        [date, st.description, st.amount, direction, st.balance, st.source]
      );
      await client.query("UPDATE staging_transactions SET status = 'force_processed' WHERE id = $1", [id]);
      return { status: 200 };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    log('ETL', `Force pushed staging item ${id} to production`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staging/dismiss - Permanently delete/dismiss a staging item
router.post('/dismiss', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!validId(id)) return res.status(400).json({ error: 'Choose a valid queued record.' });
    const result = await db.run("DELETE FROM staging_transactions WHERE id = $1 AND status IN ('duplicate', 'error', 'excluded') RETURNING id", [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Queued record not found or already processed.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
