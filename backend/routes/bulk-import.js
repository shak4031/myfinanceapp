import { Router } from 'express';
import Database from '../db.js';

const router = Router();
const db = new Database();

router.post('/execute-final', (req, res) => {
  res.status(410).json({ error: 'Shared fixture imports are disabled. Import your own CSV or PDF from the Import screen.' });
});

router.get('/verify', async (req, res, next) => {
  try {
    const stats = await db.get('SELECT COUNT(*)::int AS count, MIN(date) AS min_date, MAX(date) AS max_date FROM transactions');
    const categories = await db.all('SELECT category, COUNT(*)::int AS count FROM transactions GROUP BY category ORDER BY count DESC LIMIT 10');
    res.json({ success: true, transactionsInDatabase: stats.count, dateRange: { start: stats.min_date, end: stats.max_date }, topCategories: categories });
  } catch (error) { next(error); }
});

export default router;
