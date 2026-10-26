import { Router } from 'express';
import Database from '../db.js';
import { requireProPlus } from '../utils/license.js';

const router = Router();
router.use(requireProPlus);
const db = new Database();
const numeric = ['balance', 'apr', 'credit_limit', 'min_payment'];

function debtFields(body, partial = false) {
  const values = {};
  for (const key of ['name', ...numeric, 'due_date', 'debt_type', 'payment_in_history', 'included', 'focus']) {
    if (partial && body[key] === undefined) continue;
    if (numeric.includes(key)) {
      const value = Number(body[key] ?? 0);
      if (!Number.isFinite(value) || value < 0 || value > 1e10 || (key === 'apr' && value > 100)) throw Object.assign(new Error(`Invalid ${key}`), { status: 400 });
      values[key] = value;
    } else if (key === 'included' || key === 'focus') {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') throw Object.assign(new Error(`Choose whether the debt is ${key === 'focus' ? 'a focus' : 'in the debt-free program'}`), { status: 400 });
      values[key] = body[key] ?? key === 'included';
    } else if (key === 'payment_in_history') {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') throw Object.assign(new Error('Choose whether the debt payment is already in imported spending'), { status: 400 });
      values[key] = body[key] ?? true;
    } else if (key === 'name') {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 150) throw Object.assign(new Error('Debt name required'), { status: 400 });
      values.name = body.name.trim();
    } else if (key === 'debt_type') {
      const type = body[key] || 'credit_card';
      if (!['credit_card', 'auto_loan', 'student_loan', 'personal_loan', 'mortgage', 'other'].includes(type)) throw Object.assign(new Error('Invalid debt type'), { status: 400 });
      values[key] = type;
    } else {
      if (body[key] && !/^(?:[1-9]|[12]\d|3[01])$/.test(String(body[key]))) throw Object.assign(new Error('Due day must be between 1 and 31'), { status: 400 });
      values[key] = body[key] || null;
    }
  }
  return values;
}

async function list(req, res, next) {
  try {
    const rows = await db.all('SELECT * FROM credit_cards ORDER BY apr DESC, id');
    res.json(rows.map(row => ({
      ...row, ...Object.fromEntries(numeric.map(key => [key, Number(row[key] || 0)])),
      card_name: row.name, limit: Number(row.credit_limit || 0)
    })));
  } catch (error) { next(error); }
}

router.get('/', list);
router.post('/', (req, res, next) => Object.keys(req.body || {}).length ? create(req, res, next) : list(req, res, next));

async function create(req, res, next) {
  try {
    const fields = debtFields(req.body);
    const keys = Object.keys(fields);
    const result = await db.run(`INSERT INTO credit_cards (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(fields));
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) { next(error); }
}

router.put('/:id', async (req, res, next) => {
  try {
    const fields = debtFields(req.body, true);
    const keys = Object.keys(fields);
    if (!keys.length) return res.status(400).json({ error: 'No fields to update' });
    const result = await db.run(`UPDATE credit_cards SET ${keys.map((key, i) => `${key}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1} RETURNING id`, [...Object.values(fields), req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Debt not found' });
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.run('DELETE FROM credit_cards WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Debt not found' });
    res.json({ success: true });
  } catch (error) { next(error); }
});

export default router;
