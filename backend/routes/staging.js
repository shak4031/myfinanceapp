import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';
import { loadCategorization } from '../utils/categorization.js';
import { importTransactions } from '../utils/transactionImport.js';
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
router.post('/force-push', async (req, res, next) => {
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
      const config = await loadCategorization(client);
      const imported = await importTransactions(client, [{ ...st, date, direction }], config, st.source || 'staging_import');
      if (imported.needsReview) return { status: 409, error: 'A possible match was found. Review it before processing this record.' };
      if (imported.duplicates) return { status: 409, error: 'This transaction already exists and was not added.' };
      if (imported.imported !== 1) return { status: 409, error: 'This record was not imported. Review it before trying again.' };
      await client.query("UPDATE staging_transactions SET status = 'force_processed' WHERE id = $1", [id]);
      return { status: 200, ...imported };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    log('ETL', `Processed staging item ${id} through validated transaction import`);
    res.json({ success: true, ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
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
