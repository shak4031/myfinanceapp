import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';

const router = Router();
const db = new Database();

// Helper: Get date range based on filter
function getDateRange(filter) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  let startDate, endDate = new Date(today);
  endDate.setHours(23, 59, 59, 999);

  if (filter === 'current') {
    startDate = new Date(today.getFullYear(), today.getMonth(), 1);
    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59);
  } else if (filter === 'last') {
    startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    endDate = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);
  } else if (filter === 'ytd') {
    startDate = new Date(today.getFullYear(), 0, 1);
    endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
  } else if (filter === 'all') {
    startDate = new Date('2000-01-01');
    endDate = new Date('2099-12-31');
  } else {
    startDate = new Date(today.getFullYear(), today.getMonth(), 1);
    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59);
  }

  return {
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0]
  };
}

router.post('/', async (req, res) => {
  try {
    const { dateFilter = 'current', category } = req.body || {};
    const { startDate, endDate } = getDateRange(dateFilter);

    log('TRANSACTIONS', `Fetching transactions: ${startDate} to ${endDate}${category ? `, category: ${category}` : ''}`);

    let query = 'SELECT * FROM transactions WHERE user_id = $1 AND date >= $2 AND date <= $3';
    let params = [1, startDate, endDate];

    if (category) {
      query += ' AND category = $4';
      params.push(category);
    }

    query += ' ORDER BY date DESC';

    const transactions = await db.all(query, params);

    log('TRANSACTIONS', `Fetched ${transactions.length} transactions`);
    res.json(transactions);
  } catch (err) {
    log('TRANSACTIONS', `Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE TRANSACTION
router.post('/update-transaction', async (req, res) => {
  try {
    const { id, category, is_fixed } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: 'Transaction ID is required' });
    }

    log('TRANSACTIONS', `Updating transaction ${id}: category=${category}, is_fixed=${is_fixed}`);

    await db.run(
      'UPDATE transactions SET category = $1, is_fixed = $2 WHERE id = $3 AND user_id = $4',
      [category, is_fixed, id, 1]
    );

    res.json({ success: true, message: 'Transaction updated successfully' });
  } catch (err) {
    log('TRANSACTIONS', `Error updating transaction: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/delete-description', async (req, res) => {
  try {
    const { pattern } = req.body;
    if (!pattern) return res.status(400).json({ error: 'pattern is required' });

    log('TRANSACTIONS', `Deleting transactions matching: ${pattern}`);
    await db.run(
      'DELETE FROM transactions WHERE description LIKE $1 AND user_id = $2',
      [`%${pattern}%`, 1]
    );

    res.json({ success: true, message: `Transactions matching ${pattern} deleted` });
  } catch (err) {
    log('TRANSACTIONS', `Error deleting transactions: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/retroactive-categorize', async (req, res) => {
  try {
    log('TRANSACTIONS', 'Starting retroactive categorization...');
    
    // Define the rules (matching the backend logic)
    const rules = [
      { pattern: 'ollo|credit.*card|visa|mastercard|payment.*thank.*you|discover|amex|marriott|capital.*one|chase', category: 'Credit Cards', is_fixed: true },
      { pattern: 'hyundai|santander|car.*payment|auto.*loan|vehicle.*loan', category: 'Car Loans', is_fixed: true },
      { pattern: 'mortgage|rent|lease|apartment|property|td bank mortgage', category: 'Housing', is_fixed: true },
      { pattern: 'pseg|electricity|gas|water|power|utility|hydro|pepco|eversource|constellation|coned', category: 'Utilities', is_fixed: true },
      { pattern: 'internet|comcast|xfinity|fios|verizon|at&t|phone|mobile|wireless|cable|broadband|t-mobile', category: 'Utilities', is_fixed: true },
      { pattern: 'insurance|homeowners|renters|life.*ins|state farm|geico|allstate|usaa|progressive|amica|liberty mutual', category: 'Insurance', is_fixed: true },
      { pattern: 'netflix|amazon.*prime|prime.*video|spotify|hulu|disney|espn\\+|hbo|iptv|apple tv|youtube|crunchyroll|paramount|peacock', category: 'Subscriptions', is_fixed: false }
    ];

    let totalUpdated = 0;

    for (const rule of rules) {
      const result = await db.run(
        `UPDATE transactions 
         SET category = $1, is_fixed = $2 
         WHERE description ~* $3 AND user_id = $4`,
        [rule.category, rule.is_fixed, rule.pattern, 1]
      );
      // Note: pg doesn't return rowCount on run() in this wrapper easily, 
      // but the query will execute.
    }

    log('TRANSACTIONS', '✓ Retroactive categorization complete');
    res.json({ success: true, message: 'Database records updated to match app logic' });
  } catch (err) {
    log('TRANSACTIONS', `Error in retroactive categorization: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
