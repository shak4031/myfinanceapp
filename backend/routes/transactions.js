import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';

const router = Router();
const db = new Database();

router.post('/', async (req, res) => {
  try {
    log('TRANSACTIONS', 'Fetching all transactions');
    const { dateFilter } = req.body || {};
    
    // Get all transactions for user
    const transactions = await db.all(
      'SELECT * FROM transactions WHERE user_id = 1 ORDER BY date DESC',
      []
    );
    
    log('TRANSACTIONS', `Fetched ${transactions.length} transactions`);
    res.json(transactions);
  } catch (err) {
    log('TRANSACTIONS', `Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
