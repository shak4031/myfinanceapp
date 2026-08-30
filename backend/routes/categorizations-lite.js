import { Router } from 'express';
import sqlite3 from 'sqlite3';
import { log } from '../utils/logger.js';

const router = Router();

// Initialize SQLite database
const DB_PATH = '/opt/data/finance.db';
let db;

function initDB() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Helper to extract keywords from description
function extractKeywords(description) {
  const words = description.toLowerCase().match(/\b[a-z]+\b/g) || [];
  const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'by', 'from'];
  return words.filter(w => !stopWords.includes(w) && w.length > 2);
}

// Initialize DB on startup
try {
  await initDB();
  log('CATEGORIZATIONS_LITE', '✓ SQLite database initialized');
} catch (err) {
  log('CATEGORIZATIONS_LITE', `❌ SQLite init failed: ${err.message}`);
}

// GET /api/categorizations-lite/transactions - Get paginated transactions
router.get('/transactions', (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const perPage = 20;
    const offset = (page - 1) * perPage;

    // Get total count
    db.get('SELECT COUNT(*) as total FROM finance_transactions', (err, countRow) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const total = countRow.total;

      // Get confirmed count
      db.get(
        'SELECT COUNT(*) as confirmed FROM categorization_status WHERE status = "confirmed"',
        (err, confirmedRow) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }

          const confirmed = confirmedRow?.confirmed || 0;

          // Get modified count
          db.get(
            'SELECT COUNT(*) as modified FROM categorization_status WHERE status = "modified"',
            (err, modifiedRow) => {
              if (err) {
                return res.status(500).json({ error: err.message });
              }

              const modified = modifiedRow?.modified || 0;
              const pending = total - confirmed - modified;

              // Get transactions for this page
              db.all(
                `SELECT 
                  t.txn_id,
                  t.date,
                  t.description,
                  t.amount,
                  t.direction,
                  t.category,
                  COALESCE(cs.status, 'pending') as status
                FROM finance_transactions t
                LEFT JOIN categorization_status cs ON t.txn_id = cs.txn_id
                ORDER BY t.date DESC
                LIMIT ? OFFSET ?`,
                [perPage, offset],
                (err, rows) => {
                  if (err) {
                    return res.status(500).json({ error: err.message });
                  }

                  const CATEGORIES = [
                    'Groceries',
                    'Dining & Restaurants',
                    'Shopping & Online',
                    'Electronics',
                    'Clothing & Fashion',
                    'Subscriptions',
                    'Home & Garden',
                    'Personal Care',
                    'Medical & Vet',
                    'Education & Kids',
                    'Entertainment',
                    'Gifts & Charity',
                    'Travel',
                    'Auto & Fuel',
                    'EV Charging',
                    'Utilities',
                    'Insurance',
                    'Other'
                  ];

                  const transactions = rows.map(row => {
                    // For now, no learned category lookup in sync mode
                    return {
                      txn_id: row.txn_id,
                      date: row.date,
                      description: row.description,
                      amount: row.amount,
                      direction: row.direction,
                      auto_category: row.category || 'Uncategorized',
                      learned_category: null,
                      status: row.status
                    };
                  });

                  const totalPages = Math.ceil(total / perPage);

                  log('CATEGORIZATIONS_LITE', `Fetched page ${page}: ${transactions.length} transactions`);

                  res.json({
                    success: true,
                    data: transactions,
                    pagination: {
                      page,
                      per_page: perPage,
                      total,
                      total_pages: totalPages
                    },
                    stats: {
                      total,
                      confirmed,
                      modified,
                      pending
                    },
                    categories: CATEGORIES
                  });
                }
              );
            }
          );
        }
      );
    });
  } catch (err) {
    log('CATEGORIZATIONS_LITE', `Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categorizations-lite/transaction/:txn_id/confirm
router.post('/transaction/:txn_id/confirm', (req, res) => {
  try {
    const { txn_id } = req.params;
    const now = new Date().toISOString();

    db.run(
      `INSERT OR REPLACE INTO categorization_status (txn_id, status, confirmed_at)
       VALUES (?, 'confirmed', ?)`,
      [txn_id, now],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        log('CATEGORIZATIONS_LITE', `Confirmed transaction ${txn_id}`);
        res.json({ success: true, message: 'Transaction confirmed' });
      }
    );
  } catch (err) {
    log('CATEGORIZATIONS_LITE', `Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categorizations-lite/transaction/:txn_id/modify
router.post('/transaction/:txn_id/modify', (req, res) => {
  try {
    const { txn_id } = req.params;
    const { category } = req.body;
    const now = new Date().toISOString();

    const CATEGORIES = [
      'Groceries', 'Dining & Restaurants', 'Shopping & Online', 'Electronics',
      'Clothing & Fashion', 'Subscriptions', 'Home & Garden', 'Personal Care',
      'Medical & Vet', 'Education & Kids', 'Entertainment', 'Gifts & Charity',
      'Travel', 'Auto & Fuel', 'EV Charging', 'Utilities', 'Insurance', 'Other'
    ];

    if (!category || !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    // Update transaction category
    db.run(
      'UPDATE finance_transactions SET category = ? WHERE txn_id = ?',
      [category, txn_id],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        // Update status
        db.run(
          `INSERT OR REPLACE INTO categorization_status (txn_id, status, modified_at)
           VALUES (?, 'modified', ?)`,
          [txn_id, now],
          function(err) {
            if (err) {
              return res.status(500).json({ error: err.message });
            }

            // Get description for learning
            db.get(
              'SELECT description FROM finance_transactions WHERE txn_id = ?',
              [txn_id],
              (err, row) => {
                if (err || !row) {
                  log('CATEGORIZATIONS_LITE', `Modified transaction ${txn_id} -> ${category}`);
                  return res.json({ success: true, message: 'Transaction updated' });
                }

                const description = row.description;
                const keywords = extractKeywords(description);

                // Learn patterns
                let completed = 0;
                if (keywords.length === 0) {
                  log('CATEGORIZATIONS_LITE', `Modified transaction ${txn_id} -> ${category} (no keywords)`);
                  return res.json({ success: true, message: 'Transaction updated and pattern learned' });
                }

                keywords.forEach(keyword => {
                  db.run(
                    `INSERT INTO learned_categorizations (keyword, category, usage_count)
                     VALUES (?, ?, 1)
                     ON CONFLICT(keyword, category) DO UPDATE SET
                     usage_count = usage_count + 1`,
                    [keyword, category],
                    (err) => {
                      completed++;
                      if (completed === keywords.length) {
                        log('CATEGORIZATIONS_LITE', `Modified transaction ${txn_id} -> ${category} with ${keywords.length} keywords learned`);
                        res.json({ success: true, message: 'Transaction updated and pattern learned' });
                      }
                    }
                  );
                });
              }
            );
          }
        );
      }
    );
  } catch (err) {
    log('CATEGORIZATIONS_LITE', `Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categorizations-lite/stats
router.get('/stats', (req, res) => {
  try {
    db.get('SELECT COUNT(*) as total FROM finance_transactions', (err, totalRow) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const total = totalRow.total;

      db.get(
        'SELECT COUNT(*) as confirmed FROM categorization_status WHERE status = "confirmed"',
        (err, confirmedRow) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }

          const confirmed = confirmedRow?.confirmed || 0;

          db.get(
            'SELECT COUNT(*) as modified FROM categorization_status WHERE status = "modified"',
            (err, modifiedRow) => {
              if (err) {
                return res.status(500).json({ error: err.message });
              }

              const modified = modifiedRow?.modified || 0;
              const pending = total - confirmed - modified;

              db.get(
                'SELECT COUNT(DISTINCT keyword) as count FROM learned_categorizations',
                (err, learnedRow) => {
                  const learned = learnedRow?.count || 0;

                  res.json({
                    total,
                    confirmed,
                    modified,
                    pending,
                    learned_patterns: learned
                  });
                }
              );
            }
          );
        }
      );
    });
  } catch (err) {
    log('CATEGORIZATIONS_LITE', `Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
