import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';

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
router.post('/force-push', async (req, res) => {
  try {
    const { id } = req.body;
    const st = await db.get("SELECT * FROM staging_transactions WHERE id = $1", [id]);
    
    if (!st) return res.status(404).json({ error: 'Staging item not found' });

    // Insert into main transactions table regardless of logic
    await db.run(
      `INSERT INTO transactions (date, description, amount, direction, balance, source, user_id, category) 
       VALUES ($1, $2, $3, $4, $5, $6, 1, 'Other')`,
      [st.date, st.description, st.amount, st.direction, st.balance, st.source]
    );

    // Mark as processed
    await db.run("UPDATE staging_transactions SET status = 'force_processed' WHERE id = $1", [id]);
    
    log('ETL', `Force pushed staging item ${id} to production`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
