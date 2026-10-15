import { Router } from 'express';
import Database from '../db.js';
import { currentUserId } from '../utils/tenant.js';
import { TENANT, RULES_SQL, canonicalMerchant, loadCategorization, saveRule, applyUpdates, preview, failure } from '../utils/categorization.js';

const router = Router();
const db = new Database();
const route = handler => async (req, res) => {
  try { await handler(req, res); } catch (error) {
    res.status(error.status || (error.code === '23505' ? 409 : 500)).json({ error: error.message });
  }
};

router.post('/', route(async (req, res) => {
  const { dateFilter = 'current', category } = req.body || {};
  const now = new Date();
  let start = '2000-01-01', end = '2099-12-31';
  if (dateFilter !== 'all') {
    const year = now.getFullYear(), month = now.getMonth();
    const first = dateFilter === 'ytd' ? new Date(year, 0, 1) : new Date(year, month - (dateFilter === 'last' ? 1 : 0), 1);
    const last = dateFilter === 'last' ? new Date(year, month, 0) : dateFilter === 'ytd' ? now : new Date(year, month + 1, 0);
    const format = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    start = format(first); end = format(last);
  }
  res.json(await db.all(`SELECT * FROM transactions WHERE ${TENANT} AND date >= $1 AND date <= $2
    ${category ? 'AND category=$3' : ''} ORDER BY date DESC, id DESC`, category ? [start, end, category] : [start, end]));
}));

router.get('/categorization-rules', route(async (req, res) => {
  // Listing remains available even if an invalid legacy rule needs repair.
  const rules = await db.all(RULES_SQL);
  const categories = await db.all(`SELECT id,name FROM categories WHERE ${TENANT} ORDER BY name`);
  res.json({ rules, categories });
}));
router.post('/categorization-rules', route(async (req, res) => {
  res.json({ rule: await db.transaction(client => saveRule(client, req.body)) });
}));
router.put('/categorization-rules/:id', route(async (req, res) => {
  res.json({ rule: await db.transaction(client => saveRule(client, req.body, req.params.id)) });
}));
router.post('/categorization-preview', route(async (req, res) => {
  const result = await db.transaction(async client => {
    const config = await loadCategorization(client);
    const transactions = (await client.query(`SELECT id,description,direction,category,category_corrected FROM transactions WHERE ${TENANT} ORDER BY id`)).rows;
    return preview(transactions, config.compiled, config.names, req.body?.scope);
  });
  res.json(result);
}));
router.post('/categorization-apply', route(async (req, res) => {
  res.json(await applyUpdates(db, req.body?.updates));
}));
router.post('/cleanup-database', (req, res) => res.status(409).json({
  error: 'Automatic cleanup is disabled. Request /api/transactions/categorization-preview and approve selected updates with /api/transactions/categorization-apply. Categories and fixed flags were not changed.'
}));

router.post('/update-transaction', route(async (req, res) => {
  const { id, category } = req.body || {};
  // Category edits never modify fixed flags or other transactions.
  const result = await applyUpdates(db, [{ id, category }], { expected: false, protectCorrections: false });
  res.json({ success: true, ...result });
}));

router.post('/update-fixed', route(async (req, res) => {
  const { id, is_fixed, apply_to_all = true } = req.body || {};
  if (!id || typeof is_fixed !== 'boolean' || typeof apply_to_all !== 'boolean') throw failure(400, 'id and boolean is_fixed/apply_to_all are required');
  const updated = await db.transaction(async client => {
    const txn = (await client.query(`SELECT id,description,category FROM transactions WHERE id=$1 AND ${TENANT} FOR UPDATE`, [id])).rows[0];
    if (!txn) throw failure(404, 'Transaction not found');
    if (!apply_to_all) return (await client.query(`UPDATE transactions SET is_fixed=$1 WHERE id=$2 AND ${TENANT}`, [is_fixed, id])).rowCount;
    const pattern = canonicalMerchant(txn.description);
    const label = (await client.query(`INSERT INTO transaction_labels (pattern,display_label,match_type,is_fixed)
      VALUES ($1,$1,'merchant',$2) ON CONFLICT (user_id,pattern) DO UPDATE SET is_fixed=EXCLUDED.is_fixed,
      match_type='merchant' RETURNING id`, [pattern, is_fixed])).rows[0];
    const transactions = (await client.query(`SELECT id,description FROM transactions WHERE ${TENANT} ORDER BY id FOR UPDATE`)).rows;
    const ids = transactions.filter(row => canonicalMerchant(row.description) === pattern).map(row => row.id);
    return (await client.query(`UPDATE transactions SET is_fixed=$1,label_id=$2 WHERE id=ANY($3::integer[]) AND ${TENANT}`, [is_fixed, label.id, ids])).rowCount;
  });
  res.json({ success: true, updated });
}));

router.post('/bulk-update-category', (req, res) => res.status(409).json({ error: 'Use categorization-preview and categorization-apply with explicit transaction IDs.' }));
router.post('/sync-labels', (req, res) => res.status(409).json({ error: 'Automatic label creation is disabled. Save explicit categorization-rules instead.' }));

router.post('/delete-by-id', route(async (req, res) => {
  if (!req.body?.id) throw failure(400, 'id is required');
  const result = await db.run(`DELETE FROM transactions WHERE id=$1 AND ${TENANT}`, [req.body.id]);
  if (!result.rowCount) throw failure(404, 'Transaction not found');
  res.json({ success: true });
}));
router.post('/delete-description', route(async (req, res) => {
  if (typeof req.body?.pattern !== 'string' || !req.body.pattern.trim()) throw failure(400, 'pattern is required');
  const result = await db.run(`DELETE FROM transactions WHERE description=$1 AND ${TENANT}`, [req.body.pattern]);
  if (!result.rowCount) throw failure(404, 'Transaction not found');
  res.json({ success: true, deleted: result.rowCount });
}));
router.post('/insert-manual', route(async (req, res) => {
  const { date, description, category, amount, direction, balance, source } = req.body || {};
  if (!date || !description || !Number.isFinite(Number(amount)) || !['DEBIT','CREDIT'].includes(direction)) throw failure(400, 'Valid date, description, amount and direction are required');
  const cat = await db.get(`SELECT id FROM categories WHERE name=$1 AND ${TENANT}`, [category]);
  if (!cat) throw failure(400, 'Unknown category');
  await db.run(`INSERT INTO transactions (date,description,category,amount,direction,balance,source,user_id,category_corrected)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)`, [date,description,category,amount,direction,balance,source,currentUserId()]);
  res.json({ success: true });
}));
router.post('/dedup', route(async (req, res) => {
  const result = await db.run(`WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY date,regexp_replace(description,'[[:space:]]+',' ','g'),amount,direction
      ORDER BY category_corrected DESC,is_fixed DESC,length(description) DESC,id DESC) AS rn
    FROM transactions WHERE ${TENANT})
    DELETE FROM transactions WHERE id IN (SELECT id FROM ranked WHERE rn>1) AND ${TENANT}`);
  res.json({ success: true, removed: result.rowCount });
}));

export default router;
