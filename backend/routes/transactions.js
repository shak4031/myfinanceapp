import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';
import { normalizeDescription, dedupWhereClause, extractMerchantCore, buildLabelPattern, escapeRegex } from '../utils/normalize.js';

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
    const { id, category, is_fixed, apply_to_all = true } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: 'Transaction ID is required' });
    }

    log('TRANSACTIONS', `Updating transaction ${id}: category=${category}, is_fixed=${is_fixed}, apply_to_all=${apply_to_all}`);

    // Get the description of the transaction we're updating
    const txn = await db.get('SELECT description FROM transactions WHERE id = $1', [id]);
    
    if (!txn) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (apply_to_all) {
      // ALWAYS build clean, specific pattern from the actual transaction description
      const canonicalPattern = buildLabelPattern(txn.description);
      const coreMerchant = extractMerchantCore(txn.description) || txn.description;

      const catRow = await db.get('SELECT id FROM categories WHERE name = $1', [category]);
      const catId = catRow?.id || null;

      // Find or insert specific label for this merchant pattern
      let targetLabelId;
      const existingLabel = await db.get('SELECT id FROM transaction_labels WHERE pattern = $1', [canonicalPattern]);
      if (existingLabel) {
        targetLabelId = existingLabel.id;
        await db.run(
          'UPDATE transaction_labels SET is_fixed = $1, category_id = $2 WHERE id = $3',
          [is_fixed, catId, targetLabelId]
        );
      } else {
        const insertRes = await db.pool.query(
          'INSERT INTO transaction_labels (pattern, display_label, category_id, is_fixed) VALUES ($1, $2, $3, $4) RETURNING id',
          [canonicalPattern, coreMerchant, catId, is_fixed]
        );
        targetLabelId = insertRes.rows[0]?.id;
      }

      // Update ONLY transactions matching this specific merchant pattern
      await db.run(
        'UPDATE transactions SET category = $1, is_fixed = $2, label_id = $3 WHERE description ~* $4 AND user_id = $5',
        [category, is_fixed, targetLabelId, canonicalPattern, 1]
      );
    } else {
      // Update just this one
      await db.run(
        'UPDATE transactions SET category = $1, is_fixed = $2 WHERE id = $3 AND user_id = $4',
        [category, is_fixed, id, 1]
      );
    }

    res.json({ 
      success: true, 
      message: apply_to_all ? 'All matching transactions updated' : 'Transaction updated successfully' 
    });
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
    
    // 1. Seed Categories (ensure consistent IDs)
    const categoryCheck = await this.pool.query('SELECT COUNT(*) FROM categories');
    if (categoryCheck.rows[0].count === '0') {
      const categories = [
        ['Groceries', '🛒', '#2ecc71'], ['Utilities', '⚡', '#3498db'], ['EV Charging', '🔌', '#00bcd4'], ['Gas', '⛽', '#e74c3c'],
        ['Dining', '🍽️', '#f39c12'], ['Shopping', '🛍️', '#9b59b6'], ['Entertainment', '🎬', '#e91e63'],
        ['Healthcare', '🏥', '#00bcd4'], ['Insurance', '🛡️', '#673ab7'], ['Subscriptions', '📺', '#ff9800'],
        ['Transportation', '🚗', '#795548'], ['Home', '🏠', '#cddc39'], ['Salary', '💵', '#1b5e20'],
        ['Credit Cards', '🗂️', '#ff6b6b'], ['Car Loans', '🏎️', '#e74c3c'], ['Internet', '🌐', '#3498db'], 
        ['Other', '📦', '#424242']
      ];
      for (const [name, icon, color] of categories) {
        await this.pool.query('INSERT INTO categories (name, icon, color) VALUES ($1, $2, $3)', [name, icon, color]);
      }
      log('DATABASE', '✓ Categories seeded');
    }

    // 2. Clear ALL transaction tags to force a holistic categorization cycle
    await db.run('UPDATE transactions SET category = NULL, is_fixed = FALSE');

    // 3. Holistic Categorization (Unified Source of Truth logic)
    const rules = [
      // BILLS (Fixed)
      { pattern: 'ollo|credit.*card|payment.*thank|capital.*one|amex|chase|discover|mastercard|visa|marriott', category: 'Credit Cards', fixed: true },
      { pattern: 'hyundai|santander|car.*payment|auto.*loan', category: 'Car Loans', fixed: true },
      { pattern: 'mortgage|rent|lease|pennymac', category: 'Home', fixed: true },
      { pattern: 'pseg|utility|electricity|water|gas', category: 'Utilities', fixed: true },
      { pattern: 'verizon|comcast|xfinity|fios|t-mobile|internet', category: 'Internet', fixed: true },
      { pattern: 'state farm|insurance|geico|allstate', category: 'Insurance', fixed: true },
      { pattern: 'chargepoint|tesla|supercharger|blink|ev charging|plugshare|electric vehicle charging', category: 'EV Charging', fixed: false },
      
      // LIFESTYLE (Not Fixed)
      { pattern: 'paypal|target|klarna|amazon|walmart|etsy|michael|shopping', category: 'Shopping', fixed: false },
      { pattern: 'restaurant|cafe|dining|roy rogers|pizza|grubhub|uber.*eats|doordash|starbucks|chipotle|five guys|baking|bakery', category: 'Dining', fixed: false },
      { pattern: 'netflix|hulu|spotify|disney|hbo|youtube|subscriptions', category: 'Subscriptions', fixed: false },
      { pattern: 'grocery|shoprite|wawa|trader joe|whole foods|instacart|bereket', category: 'Groceries', fixed: false },
      { pattern: 'pharmacy|cvs|walgreens|healthcare|hospital|medical', category: 'Healthcare', fixed: false },
      { pattern: 'payroll|salary|wells fargo|bonus|deposit', category: 'Salary', fixed: false }
    ];

    for (const rule of rules) {
       await db.run(
        `UPDATE transactions 
         SET category = $1, is_fixed = $2
         WHERE description ~* $3 AND user_id = 1`,
        [rule.category, rule.fixed, rule.pattern]
      );
    }

    // 4. Backup: Anything still NULL gets 'Other'
    await db.run("UPDATE transactions SET category = 'Other' WHERE category IS NULL");

    log('TRANSACTIONS', '✓ Holistic database cleanup and categorization complete');
    res.json({ success: true, message: 'Database successfully re-categorized.' });
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
    `);

    const otherCat = await db.get("SELECT id FROM categories WHERE name = 'Other'");
    let createdCount = 0;

    for (const t of unlabeled) {
        const cleanLabel = buildLabelPattern(t.description);
        const displayLabel = extractMerchantCore(t.description) || cleanLabel;
        
        // Check if label already exists (prevent duplicates in label table)
        const exists = await db.get("SELECT id FROM transaction_labels WHERE pattern = $1", [cleanLabel]);
        
        let labelId;
        if (!exists) {
            const result = await db.pool.query(
                "INSERT INTO transaction_labels (pattern, display_label, category_id, is_fixed) VALUES ($1, $2, $3, FALSE) RETURNING id",
                [cleanLabel, displayLabel, otherCat.id]
            );
            labelId = result.rows[0].id;
            createdCount++;
        } else {
            labelId = exists.id;
        }

        // Link all transactions matching this pattern
        await db.run("UPDATE transactions SET label_id = $1 WHERE description ~* $2 AND user_id = 1", [labelId, cleanLabel]);
    }

    res.json({ success: true, message: `Synced ${unlabeled.length} descriptions, created ${createdCount} new unique labels.` });
  } catch (err) {
    log('TRANSACTIONS', `Error syncing labels: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE FIXED FLAG
router.post('/update-fixed', async (req, res) => {
  try {
    const { id, is_fixed, apply_to_all = true } = req.body;
    
    if (!id) return res.status(400).json({ error: 'Transaction ID is required' });

    const isFixedBool = is_fixed === true || is_fixed === 'true' || is_fixed === 1 || is_fixed === '1';
    log('TRANSACTIONS', `Updating Fixed Flag: txn_id=${id}, is_fixed=${isFixedBool}, apply_to_all=${apply_to_all}`);

    const txn = await db.get('SELECT description, category FROM transactions WHERE id = $1', [id]);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    if (apply_to_all) {
      const canonicalPattern = buildLabelPattern(txn.description);
      const coreMerchant = extractMerchantCore(txn.description) || txn.description;

      const catRow = await db.get('SELECT id FROM categories WHERE name = $1', [txn.category]);
      const catId = catRow?.id || null;

      // 1. Update or create label in transaction_labels
      let targetLabelId;
      const existingLabel = await db.get('SELECT id FROM transaction_labels WHERE pattern = $1', [canonicalPattern]);
      if (existingLabel) {
        targetLabelId = existingLabel.id;
        await db.run(
          'UPDATE transaction_labels SET is_fixed = $1 WHERE id = $2',
          [isFixedBool, targetLabelId]
        );
      } else {
        const insertRes = await db.pool.query(
          'INSERT INTO transaction_labels (pattern, display_label, category_id, is_fixed) VALUES ($1, $2, $3, $4) RETURNING id',
          [canonicalPattern, coreMerchant, catId, isFixedBool]
        );
        targetLabelId = insertRes.rows[0]?.id;
      }

      // 2. Propagate is_fixed and label_id to ONLY transactions matching this specific merchant
      await db.run(
        'UPDATE transactions SET is_fixed = $1, label_id = $2 WHERE description ~* $3 AND user_id = 1',
        [isFixedBool, targetLabelId, canonicalPattern]
      );
    } else {
      await db.run(
        'UPDATE transactions SET is_fixed = $1 WHERE id = $2 AND user_id = 1',
        [isFixedBool, id]
      );
    }

    res.json({ success: true, message: 'Fixed flag updated for all matching transactions' });
  } catch (err) {
    log('TRANSACTIONS', `Error updating fixed flag: ${err.message}`);
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

router.post('/delete-by-id', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });

    log('TRANSACTIONS', `Deleting transaction id: ${id}`);
    await db.run('DELETE FROM transactions WHERE id = $1 AND user_id = 1', [id]);

    res.json({ success: true, message: `Transaction ${id} deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/insert-manual', async (req, res) => {
  try {
    const { date, description, category, amount, direction, balance, source } = req.body;
    
    await db.run(
      `INSERT INTO transactions (date, description, category, amount, direction, balance, source, user_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
      [date, description, category, amount, direction, balance, source]
    );
    res.json({ success: true, message: 'Manual transaction inserted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/transactions/dedup
 * 
 * Deduplicate the entire transactions table by normalizing descriptions
 * (collapsing whitespace) and removing duplicate transactions.
 * 
 * Strategy per group (date, normalized desc, amount, direction):
 *   1. Keep the row with the longest description (most complete data)
 *   2. Keep the row with the most recent created_at (if descriptions same length)
 *   3. Delete extras
 * 
 * Safe for repeat runs — idempotent.
 */
router.post('/dedup', async (req, res) => {
  try {
    log('DEDUP', '🔍 Starting full database deduplication...');

    // Find duplicates using normalized descriptions
    const duplicates = await db.all(`
      WITH normalized AS (
              SELECT 
                id, date, 
                regexp_replace(description, '[[:space:]]+', ' ', 'g') AS norm_desc,
                description,
                amount, direction
              FROM transactions
              WHERE user_id = 1
            ),
            ranked AS (
              SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY date, norm_desc, amount, direction
                  ORDER BY LENGTH(description) DESC, id DESC
                ) AS rn
              FROM normalized
            )
      SELECT id, date, description, norm_desc, amount, direction, rn
      FROM ranked
      WHERE rn > 1
      ORDER BY date, norm_desc
    `);

    if (duplicates.length === 0) {
      log('DEDUP', '✅ No duplicates found — database is clean');
      return res.json({ success: true, removed: 0, message: 'No duplicates found' });
    }

    const dupIds = duplicates.map(d => d.id);
    log('DEDUP', `📊 Found ${duplicates.length} duplicate rows to remove`);

    // Log sample duplicates for audit
    const sampleGroups = {};
    for (const d of duplicates) {
      const key = `${d.date}|${d.norm_desc}|${d.amount}|${d.direction}`;
      if (!sampleGroups[key]) sampleGroups[key] = [];
      sampleGroups[key].push(d);
    }
    const groupEntries = Object.entries(sampleGroups);
    log('DEDUP', `📋 ${groupEntries.length} unique duplicate groups detected`);
    for (const [key, rows] of groupEntries.slice(0, 5)) {
      const [date, desc, amt, dir] = key.split('|');
      log('DEDUP', `  Group: ${date} | $${amt} ${dir} | "${desc.substring(0, 40)}" → ${rows.length + 1} total (keeping 1, removing ${rows.length})`);
    }

    // Delete duplicates in batches (Postgres has limits on IN clause size)
    const BATCH_SIZE = 100;
    let totalRemoved = 0;
    for (let i = 0; i < dupIds.length; i += BATCH_SIZE) {
      const batch = dupIds.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map((_, idx) => `$${idx + 1}`).join(',');
      const result = await db.run(
        `DELETE FROM transactions WHERE id IN (${placeholders})`,
        batch
      );
      totalRemoved += batch.length;
    }

    log('DEDUP', `✅ Dedup complete: ${totalRemoved} duplicate rows removed`);

    // Return audit trail
    res.json({
      success: true,
      removed: totalRemoved,
      groups: groupEntries.length,
      sampleGroups: groupEntries.slice(0, 10).map(([key, rows]) => {
        const [date, desc, amt, dir] = key.split('|');
        return { date, description: desc, amount: parseFloat(amt), direction: dir, removed: rows.length };
      })
    });
  } catch (err) {
    log('DEDUP', `❌ Dedup failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
