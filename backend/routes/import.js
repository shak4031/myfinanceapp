import express from 'express';
import { log } from '../utils/logger.js';
import Database from '../db.js';

const router = express.Router();
const db = new Database();

/**
 * HARDENED CSV IMPORT - FIXED FOR ALL TD VARIANTS
 */

// Strict Exclusion List
const EXCLUSION_PATTERNS = [
  'Online Xfer Transfer from CK x5261',
  'Online Xfer Transfer from CK x5237'
];

function categorize(description) {
  if (!description) return 'Other';
  const desc = description.toUpperCase();

  // EXCLUSIONS
  if (EXCLUSION_PATTERNS.some(p => description.includes(p))) return null;

  const rules = {
    'Groceries': ['GROCERY', 'SAFEWAY', 'WHOLE FOODS', 'TRADER JOE', 'INSTACART', 'WAWA'],
    'Dining': ['RESTAURANT', 'CAFE', 'CHIPOTLE', 'ROY ROGERS', 'PIZZA', 'FIVE GUYS', 'STARBUCKS'],
    'Shopping': ['TARGET', 'AMAZON', 'ETSY', 'WALMART', 'PAYPAL', 'AFFIRM', 'KLARNA', 'HOME DEPOT'],
    'Transportation': ['UBER', 'LYFT', 'TAXI', 'HYUNDAI', 'LEASE'],
    'Utilities': ['ELECTRIC', 'WATER', 'GAS', 'VERIZON', 'COMCAST', 'PSEG', 'FIOS'],
    'Insurance': ['STATE FARM', 'ALLSTATE', 'GEICO', 'INSURANCE'],
    'Salary': ['WELLS FARGO', 'PAYROLL', 'DIRECT DEP'],
    'Credit Cards': ['OLLO', 'CAPITAL ONE', 'AMEX', 'CHASE', 'DISCOVER', 'CREDIT CARD']
  };

  for (const [category, keywords] of Object.entries(rules)) {
    if (keywords.some(k => desc.includes(k))) return category;
  }
  return 'Other';
}

router.post('/import-csv', async (req, res) => {
  const startTime = Date.now();
  try {
    const { csvData, source } = req.body;
    if (!csvData) return res.status(400).json({ success: false, error: 'No data' });

    log('IMPORT', '--- STARTING HARDENED IMPORT ---');

    const lines = csvData.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    
    // THE FIX: Hard-coded index mapping for your specific CSV structure to stop fuzzy errors
    // Date,Bank RTN,Account Number,Transaction Type,Description,Debit,Credit,Check Number,Account Name,Running Balance
    let dateIdx = -1, typeIdx = -1, descIdx = -1, debitIdx = -1, creditIdx = -1, balanceIdx = -1;

    headers.forEach((h, i) => {
      const low = h.toLowerCase();
      if (low === 'date') dateIdx = i;
      if (low === 'transaction type') typeIdx = i;
      if (low === 'description') descIdx = i;
      if (low === 'debit') debitIdx = i;
      if (low === 'credit') creditIdx = i;
      if (low === 'running balance' || low === 'balance') balanceIdx = i;
    });

    log('IMPORT', `MAPPING: Date:${dateIdx}, Type:${typeIdx}, Desc:${descIdx}, Debit:${debitIdx}, Credit:${creditIdx}`);

    const transactions = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      if (cols.length < 3) continue;

      const date = cols[dateIdx];
      
      // CRITICAL FIX: Explicitly force usage of Description column index
      // If it's empty or just meta, and we have a type column, we ensure they are NOT the same.
      let description = cols[descIdx];
      const type = cols[typeIdx];

      // Rescue Case: If we accidentally hit DEBIT/CREDIT in the desc column, scan ALL columns for the real string
      if (!description || description === 'DEBIT' || description === 'CREDIT' || description === 'XFER') {
         description = cols.find(c => c.length > 5 && c !== date && c !== type) || type;
      }

      const debit = parseFloat(cols[debitIdx]) || 0;
      const credit = parseFloat(cols[creditIdx]) || 0;
      const amount = debit > 0 ? debit : credit;
      const direction = debit > 0 ? 'DEBIT' : 'CREDIT';
      const balance = parseFloat(cols[balanceIdx]) || null;

      if (!amount) continue;

      const category = categorize(description);
      if (!category && category !== 'Other') continue; // Excluded

      transactions.push({ date, description, category, amount, direction, balance, source: source || 'checking' });
    }

    let imported = 0, duplicates = 0;

    for (const t of transactions) {
      const exist = await db.get(
        "SELECT id FROM transactions WHERE date = $1 AND description = $2 AND amount = $3 AND direction = $4",
        [t.date, t.description, t.amount, t.direction]
      );

      if (exist) {
        duplicates++;
        continue;
      }

    // Find Label
    let labelId = null;
    let isFixed = false;
    const labels = await db.all("SELECT id, pattern, is_fixed FROM transaction_labels");
    for (const l of labels) {
      if (new RegExp(l.pattern, 'i').test(t.description)) {
        labelId = l.id;
        isFixed = l.is_fixed === true || l.is_fixed === 1 || l.is_fixed === 'true';
        break;
      }
    }

    await db.run(
      `INSERT INTO transactions (date, description, amount, direction, balance, source, user_id, category, label_id, is_fixed) 
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)`,
      [t.date, t.description, t.amount, t.direction, t.balance, t.source, t.category, labelId, isFixed]
    );
      imported++;
    }

    res.json({ success: true, imported, duplicates, total: transactions.length });

  } catch (err) {
    log('IMPORT', `FAILED: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
