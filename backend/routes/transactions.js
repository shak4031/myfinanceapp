import { Router } from 'express';
import Database from '../db.js';
import { currentUserId } from '../utils/tenant.js';
import { TENANT, RULES_SQL, canonicalMerchant, loadCategorization, saveRule, applyUpdates, preview, failure } from '../utils/categorization.js';
import { isPayMode } from '../utils/payMode.js';
import { isIncomeRole, incomeSources } from '../utils/income.js';
import { applyNameRules, compileNameRules, currentNameRule, listNameRules, loadNameRules, previewNameRule, resolveName, suggestNamePattern, validateNameRule } from '../utils/naming.js';

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
    const transactions = (await client.query(`SELECT id,date,description,amount,direction,category,category_corrected FROM transactions WHERE ${TENANT} ORDER BY id`)).rows;
    return { ...preview(transactions, config.compiled, config.names, req.body?.scope), invalidRules: config.invalidRules };
  });
  res.json(result);
}));
router.post('/categorization-apply', route(async (req, res) => {
  const learnRules = req.body?.learnRules ?? false;
  // Explicit user-confirmed bulk edits may replace earlier manual corrections; stale checks still apply.
  const protectCorrections = req.body?.protectCorrections ?? true;
  if (typeof learnRules !== 'boolean') throw failure(400, 'learnRules must be a boolean');
  if (typeof protectCorrections !== 'boolean') throw failure(400, 'protectCorrections must be a boolean');
  res.json(await applyUpdates(db, req.body?.updates, { learnRules, protectCorrections }));
}));
router.post('/cleanup-database', (req, res) => res.status(409).json({
  error: 'Automatic cleanup is disabled. Request /api/transactions/categorization-preview and approve selected updates with /api/transactions/categorization-apply. Categories and fixed flags were not changed.'
}));

router.post('/update-transaction', route(async (req, res) => {
  const { id, category } = req.body || {};
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1 || typeof category !== 'string') {
    throw failure(400, 'A valid transaction id and category are required');
  }
  if (!category) {
    const result = await db.transaction(async client => {
      const transaction = (await client.query(`SELECT id,description FROM transactions WHERE id=$1 AND ${TENANT} FOR UPDATE`, [id])).rows[0];
      if (!transaction) throw failure(404, 'Transaction not found');
      await client.query(`UPDATE transactions SET previous_category=category,category=NULL,
        category_corrected=TRUE,correction_timestamp=NOW() WHERE id=$1 AND ${TENANT}`, [id]);
      const pattern = canonicalMerchant(transaction.description);
      if (pattern) await client.query(`UPDATE transaction_labels SET enabled=FALSE
        WHERE ${TENANT} AND match_type='merchant' AND pattern=$1`, [pattern]);
      return { updated: 1, rulesSaved: 0, rulesDisabled: pattern ? 1 : 0 };
    });
    return res.json({ success: true, ...result });
  }
  const result = await applyUpdates(db, [{ id, category }], {
    expected: false, protectCorrections: false, learnRules: true
  });
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

router.post('/update-fixed-many', route(async (req, res) => {
  const { ids, is_fixed } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || typeof is_fixed !== 'boolean'
    || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw failure(400, 'ids (unique positive integers, at most 5000) and boolean is_fixed are required');
  }
  const updated = await db.transaction(async client => {
    const found = (await client.query(`SELECT id FROM transactions WHERE id=ANY($1::integer[]) AND ${TENANT} FOR UPDATE`, [ids])).rows.length;
    if (found !== ids.length) throw failure(404, 'Transaction not found');
    return (await client.query(`UPDATE transactions SET is_fixed=$1 WHERE id=ANY($2::integer[]) AND ${TENANT}`, [is_fixed, ids])).rowCount;
  });
  res.json({ success: true, updated });
}));

router.post('/update-pay-mode', route(async (req, res) => {
  const { ids, pay_mode } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || !isPayMode(pay_mode)
    || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw failure(400, "ids (unique positive integers, at most 5000) and pay_mode ('auto', 'manual' or null) are required");
  }
  const updated = await db.transaction(async client => {
    const found = (await client.query(`SELECT id,direction FROM transactions WHERE id=ANY($1::integer[]) AND ${TENANT} FOR UPDATE`, [ids])).rows;
    if (found.length !== ids.length) throw failure(404, 'Transaction not found');
    if (found.some(row => String(row.direction).toUpperCase() !== 'DEBIT')) throw failure(400, 'Only outgoing payments can be auto-pay or manual');
    return (await client.query(`UPDATE transactions SET pay_mode=$1 WHERE id=ANY($2::integer[]) AND ${TENANT}`, [pay_mode, ids])).rowCount;
  });
  res.json({ success: true, updated });
}));

// Deposits grouped by sender, with whether each counts as pay and why, so users can correct detection.
router.get('/income-sources', route(async (req, res) => {
  const today = new Date();
  const since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 400);
  const day = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const rows = await db.all(`SELECT id,date,description,amount,direction,category,is_fixed,income_role FROM transactions
    WHERE ${TENANT} AND UPPER(direction)='CREDIT' AND date::date >= $1::date ORDER BY date DESC, id DESC`, [day(since)]);
  res.json({ sources: incomeSources(rows, today) });
}));

router.post('/update-income-role', route(async (req, res) => {
  const { ids, income_role } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || income_role === undefined || !isIncomeRole(income_role)
    || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw failure(400, "ids (unique positive integers, at most 5000) and income_role ('income', 'other' or null) are required");
  }
  const updated = await db.transaction(async client => {
    const found = (await client.query(`SELECT id,direction FROM transactions WHERE id=ANY($1::integer[]) AND ${TENANT} FOR UPDATE`, [ids])).rows;
    if (found.length !== ids.length) throw failure(404, 'Transaction not found');
    if (found.some(row => String(row.direction).toUpperCase() !== 'CREDIT')) throw failure(400, 'Only deposits can be marked as income');
    return (await client.query(`UPDATE transactions SET income_role=$1 WHERE id=ANY($2::integer[]) AND ${TENANT}`, [income_role, ids])).rowCount;
  });
  res.json({ success: true, updated });
}));

router.post('/bulk-update-category', (req, res) => res.status(409).json({ error: 'Use categorization-preview and categorization-apply with explicit transaction IDs.' }));
router.post('/sync-labels', (req, res) => res.status(409).json({ error: 'Automatic label creation is disabled. Save explicit categorization-rules instead.' }));

// Rename rules: "transactions containing these words show as <name>", applied to past rows now and future imports.
const ruleId = value => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw failure(400, 'A valid rule id is required');
  return id;
};
router.get('/name-rules', route(async (req, res) => {
  res.json({ rules: await db.transaction(listNameRules) });
}));
// Body: { pattern } to test words, or { description } to get a suggested pattern and any rule already naming it.
router.post('/name-rules/preview', route(async (req, res) => {
  const description = typeof req.body?.description === 'string' ? req.body.description : null;
  const pattern = typeof req.body?.pattern === 'string' ? req.body.pattern : description ? suggestNamePattern(description) : '';
  res.json(await db.transaction(async client => ({
    ...(description ? { suggested: suggestNamePattern(description), current: await currentNameRule(client, description) } : {}),
    ...await previewNameRule(client, { pattern })
  })));
}));
router.post('/name-rules', route(async (req, res) => {
  const { pattern, name } = validateNameRule(req.body);
  const id = req.body?.id == null ? null : ruleId(req.body.id);
  const result = await db.transaction(async client => {
    const saved = id == null
      ? await client.query(`INSERT INTO name_rules (pattern,name) VALUES ($1,$2)
          ON CONFLICT (user_id,pattern) DO UPDATE SET name=EXCLUDED.name RETURNING id,pattern,name`, [pattern, name])
      : await client.query(`UPDATE name_rules SET pattern=$1,name=$2 WHERE id=$3 AND ${TENANT} RETURNING id,pattern,name`, [pattern, name, id]);
    if (!saved.rows[0]) throw failure(404, 'Rename rule not found');
    const changed = await applyNameRules(client);
    const rule = (await listNameRules(client)).find(row => row.id === saved.rows[0].id);
    return { rule, changed };
  });
  res.json({ success: true, ...result });
}));
router.delete('/name-rules/:id', route(async (req, res) => {
  const id = ruleId(req.params.id);
  const changed = await db.transaction(async client => {
    const removed = await client.query(`DELETE FROM name_rules WHERE id=$1 AND ${TENANT}`, [id]);
    if (!removed.rowCount) throw failure(404, 'Rename rule not found');
    return applyNameRules(client);
  });
  res.json({ success: true, changed });
}));

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
  await db.transaction(async client => {
    const displayName = resolveName(description, compileNameRules(await loadNameRules(client)))?.name ?? null;
    await client.query(`INSERT INTO transactions (date,description,category,amount,direction,balance,source,user_id,category_corrected,display_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9)`, [date,description,category,amount,direction,balance,source,currentUserId(),displayName]);
  });
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
