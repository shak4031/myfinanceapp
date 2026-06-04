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

// POST /api/categorizations/list - Get all transactions with current category
router.post('/list', async (req, res) => {
  try {
    const { limit = 100, offset = 0, dateFilter = 'all' } = req.query;
    const { startDate, endDate } = getDateRange(dateFilter);

    log('CATEGORIZATIONS', `Fetching transactions: limit=${limit}, offset=${offset}, dateFilter=${dateFilter}`);

    const query = `
      SELECT 
        id, date, description, amount, category as currentCategory, previous_category as previousCategory
      FROM transactions 
      WHERE user_id = $1 AND date >= $2 AND date <= $3
      ORDER BY date DESC
      LIMIT $4 OFFSET $5
    `;

    const transactions = await db.all(query, [1, startDate, endDate, parseInt(limit), parseInt(offset)]);

    // Get counts
    const countsQuery = `
      SELECT 
        COALESCE(SUM(CASE WHEN category IS NULL OR category = '' THEN 1 ELSE 0 END), 0) as uncategorized,
        COALESCE(SUM(CASE WHEN category IS NOT NULL AND category != '' THEN 1 ELSE 0 END), 0) as categorized,
        COALESCE(SUM(CASE WHEN category_corrected = TRUE THEN 1 ELSE 0 END), 0) as recentlyCorrected
      FROM transactions 
      WHERE user_id = $1
    `;

    const counts = await db.get(countsQuery, [1]);

    log('CATEGORIZATIONS', `Fetched ${transactions.length} transactions with counts:`, counts);

    res.json({
      transactions,
      counts: {
        uncategorized: parseInt(counts.uncategorized),
        categorized: parseInt(counts.categorized),
        recentlyCorrected: parseInt(counts.recentlyCorrected)
      }
    });
  } catch (err) {
    log('CATEGORIZATIONS', `Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categorizations/update-batch - Bulk update categories
router.post('/update-batch', async (req, res) => {
  try {
    const { updates } = req.body;

    if (!Array.isArray(updates)) {
      return res.status(400).json({ error: 'updates must be an array' });
    }

    log('CATEGORIZATIONS', `Batch updating ${updates.length} transactions`);

    let successCount = 0;
    const errors = [];

    for (const { id, newCategory } of updates) {
      try {
        // Get current category for previous_category tracking
        const current = await db.get(
          'SELECT category FROM transactions WHERE id = $1',
          [id]
        );

        if (!current) {
          errors.push({ id, error: 'Transaction not found' });
          continue;
        }

        // Update with correction tracking
        await db.run(
          `UPDATE transactions 
           SET category = $1, 
               category_corrected = TRUE, 
               previous_category = $2,
               correction_timestamp = NOW()
           WHERE id = $3`,
          [newCategory, current.category, id]
        );

        successCount++;
      } catch (err) {
        errors.push({ id, error: err.message });
      }
    }

    log('CATEGORIZATIONS', `Batch update complete: ${successCount} updated, ${errors.length} errors`);

    res.json({
      success: true,
      updated: successCount,
      errors
    });
  } catch (err) {
    log('CATEGORIZATIONS', `Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categorizations/patterns - Get keyword patterns
router.post('/patterns', async (req, res) => {
  try {
    log('CATEGORIZATIONS', 'Fetching keyword patterns');

    // Extract keywords from transactions and find patterns
    const query = `
      SELECT 
        description, category, COUNT(*) as count
      FROM transactions 
      WHERE user_id = $1 AND description IS NOT NULL
      GROUP BY description, category
      ORDER BY count DESC
      LIMIT 50
    `;

    const results = await db.all(query, [1]);

    // Group by keywords and aggregate categories
    const patterns = {};

    for (const row of results) {
      const keywords = row.description.split(/[\s\-_(),\.]/i)
        .filter(w => w.length > 3)
        .map(w => w.toUpperCase());

      for (const keyword of keywords) {
        if (!patterns[keyword]) {
          patterns[keyword] = {
            keyword,
            count: 0,
            currentCategories: {},
            suggestedCategory: null
          };
        }

        patterns[keyword].count += row.count;

        if (row.category) {
          patterns[keyword].currentCategories[row.category] =
            (patterns[keyword].currentCategories[row.category] || 0) + row.count;
        }
      }
    }

    // Find suggested category (most common for each keyword)
    const patternArray = Object.values(patterns)
      .filter(p => p.count >= 3) // Only patterns with 3+ transactions
      .map(p => ({
        ...p,
        suggestedCategory: Object.keys(p.currentCategories).length > 0
          ? Object.entries(p.currentCategories).sort(([, a], [, b]) => b - a)[0][0]
          : 'Uncategorized'
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    log('CATEGORIZATIONS', `Found ${patternArray.length} patterns`);

    res.json({ patterns: patternArray });
  } catch (err) {
    log('CATEGORIZATIONS', `Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categorizations/learn-pattern - Save pattern learning
router.post('/learn-pattern', async (req, res) => {
  try {
    const { keyword, suggestedCategory } = req.body;

    if (!keyword || !suggestedCategory) {
      return res.status(400).json({ error: 'keyword and suggestedCategory required' });
    }

    log('CATEGORIZATIONS', `Learning pattern: "${keyword}" -> "${suggestedCategory}"`);

    // Find all transactions matching keyword and update them
    const query = `
      UPDATE transactions 
      SET 
        category = $1,
        category_corrected = TRUE,
        previous_category = category,
        correction_timestamp = NOW()
      WHERE user_id = $2 
        AND UPPER(description) LIKE $3
        AND category != $1
      RETURNING id
    `;

    const pattern = `%${keyword}%`;
    const result = await db.pool.query(query, [suggestedCategory, 1, pattern]);
    const updated = result.rowCount || 0;

    log('CATEGORIZATIONS', `Pattern learning complete: ${updated} transactions updated`);

    res.json({
      success: true,
      updated,
      message: `Successfully auto-learned ${updated} new patterns`
    });
  } catch (err) {
    log('CATEGORIZATIONS', `Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categorizations/category-summary - Get counts by category
router.post('/category-summary', async (req, res) => {
  try {
    log('CATEGORIZATIONS', 'Fetching category summary');

    const query = `
      SELECT 
        COALESCE(category, 'Uncategorized') as category,
        COUNT(*) as count
      FROM transactions 
      WHERE user_id = $1
      GROUP BY category
      ORDER BY count DESC
    `;

    const categories = await db.all(query, [1]);

    log('CATEGORIZATIONS', `Category summary: ${categories.length} categories`);

    res.json({ categories });
  } catch (err) {
    log('CATEGORIZATIONS', `Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categorizations/by-category - Get transactions for specific category
router.post('/by-category', async (req, res) => {
  try {
    const { category, limit = 100, offset = 0 } = req.body;

    log('CATEGORIZATIONS', `Fetching transactions for category: ${category}`);

    const query = `
      SELECT 
        id, date, description, amount, category as currentCategory, previous_category as previousCategory
      FROM transactions 
      WHERE user_id = $1 
        AND (category = $2 OR ($2 = 'Uncategorized' AND (category IS NULL OR category = '')))
      ORDER BY date DESC
      LIMIT $3 OFFSET $4
    `;

    const transactions = await db.all(query, [1, category, parseInt(limit), parseInt(offset)]);

    log('CATEGORIZATIONS', `Fetched ${transactions.length} transactions for category`);

    res.json({ transactions });
  } catch (err) {
    log('CATEGORIZATIONS', `Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
