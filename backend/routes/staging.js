import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';
import { failure, loadCategorization } from '../utils/categorization.js';
import { importTransactions } from '../utils/transactionImport.js';

const router = Router();
const db = new Database();

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
    const id = Number(req.body?.id);
    if (!Number.isSafeInteger(id) || id < 1) throw failure(400, 'A valid staging item ID is required');
    const result = await db.transaction(async client => {
      const st = (await client.query('SELECT * FROM staging_transactions WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!st) throw failure(404, 'Staging item not found');
      const config = await loadCategorization(client);
      const imported = await importTransactions(client, [st], config, st.source || 'staging_import');
      await client.query("UPDATE staging_transactions SET status='force_processed' WHERE id=$1", [id]);
      return imported;
    });
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
    const { id } = req.body;
    await db.run("DELETE FROM staging_transactions WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
