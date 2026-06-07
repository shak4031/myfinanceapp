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

router.post('/cleanup-database', async (req, res) => {
  try {
    log('TRANSACTIONS', 'Starting database deduplication and cleanup...');
    
    // 1. Remove exact duplicates (keeping the one with the lowest ID)
    await db.run(`
      DELETE FROM transactions 
      WHERE id NOT IN (
        SELECT MIN(id) 
        FROM transactions 
        GROUP BY date, description, amount, direction
      )
    `);

    // 2. Reset fixed status for everything
    await db.run('UPDATE transactions SET is_fixed = FALSE');

    // 3. Carefully re-apply fixed status to ONLY the specific monthly bills
    const fixedRules = [
      { pattern: 'mortgage|rent|lease|apartment', category: 'Housing' },
      { pattern: 'hyundai|santander|auto.*loan|car.*payment', category: 'Car Loans' },
      { pattern: 'pseg|electricity|water|gas|hydro|pepco|eversource|constellation|coned', category: 'Utilities' },
      { pattern: 'verizon|comcast|xfinity|fios|at&t|t-mobile|internet|cable|phone', category: 'Internet' },
      { pattern: 'insurance|state farm|geico|allstate|usaa|progressive', category: 'Insurance' },
      { pattern: 'ollo|credit.*card|visa|mastercard|discover|amex|marriott|capital.*one|chase', category: 'Credit Cards' }
    ];

    for (const rule of fixedRules) {
      await db.run(
        `UPDATE transactions SET is_fixed = TRUE, category = $1 
         WHERE description ~* $2 AND user_id = 1`,
        [rule.category, rule.pattern]
      );
    }

    log('TRANSACTIONS', '✓ Database cleanup and deduplication complete');
    res.json({ success: true, message: 'Database deduplicated and fixed payments recalibrated.' });
  } catch (err) {
    log('TRANSACTIONS', `Error in cleanup: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync-labels', async (req, res) => {
  try {
    log('TRANSACTIONS', 'Manual sync: Creating labels for all distinct production transactions...');
    
    // 1. Get all descriptions that don't have a label yet
    const unlabeled = await db.all(`
        SELECT DISTINCT description 
        FROM transactions 
        WHERE label_id IS NULL 
        OR label_id NOT IN (SELECT id FROM transaction_labels)
    `);

    const otherCat = await db.get("SELECT id FROM categories WHERE name = 'Other'");
    let createdCount = 0;

    for (const t of unlabeled) {
        const cleanLabel = t.description
            .replace(/\s+/g, ' ')
            .replace(/\d{4,}/g, '')
            .trim();
        
        // Check if label already exists (prevent duplicates in label table)
        const exists = await db.get("SELECT id FROM transaction_labels WHERE pattern = $1", [cleanLabel]);
        
        let labelId;
        if (!exists) {
            const result = await db.pool.query(
                "INSERT INTO transaction_labels (pattern, display_label, category_id, is_fixed) VALUES ($1, $2, $3, FALSE) RETURNING id",
                [cleanLabel, cleanLabel, otherCat.id]
            );
            labelId = result.rows[0].id;
            createdCount++;
        } else {
            labelId = exists.id;
        }

        // Link the transactions
        await db.run("UPDATE transactions SET label_id = $1 WHERE description = $2", [labelId, t.description]);
    }

    res.json({ success: true, message: `Synced ${unlabeled.length} descriptions, created ${createdCount} new unique labels.` });
  } catch (err) {
    log('TRANSACTIONS', `Error syncing labels: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk-update-category', async (req, res) => {
  try {
    const { updates } = req.body;
    if (!updates || !Array.isArray(updates)) return res.status(400).json({ error: 'updates array is required' });

    for (const update of updates) {
      const { pattern, category } = update;
      await db.run(
        `UPDATE transaction_labels 
         SET category_id = (SELECT id FROM categories WHERE name = $1) 
         WHERE pattern ~* $2`,
        [category, pattern]
      );
      
      // Update existing transactions for immediate UI consistency
      await db.run(
        `UPDATE transactions 
         SET category = $1 
         WHERE label_id IN (SELECT id FROM transaction_labels WHERE pattern ~* $2)`,
        [category, pattern]
      );
    }

    res.json({ success: true, message: 'Labels and historical transactions updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
