import { Router } from 'express';
import Database from '../db.js';
import { buildFinancialPlan } from '../utils/financialPlan.js';
import { parseTxDate } from '../utils/normalize.js';

const router = Router();
const db = new Database();

async function fundingAnalysis() {
  const goals = await db.all('SELECT * FROM savings_goals ORDER BY priority, id');
  const rows = await db.all(`
    SELECT id, date, description, category, direction, amount FROM transactions
    WHERE date::date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '3 months')::date
      AND date::date < date_trunc('month', CURRENT_DATE)::date
  `);
  const debts = await db.all('SELECT min_payment,payment_in_history FROM credit_cards WHERE balance > 0');
  return { goals, plan: buildFinancialPlan(rows, goals, new Date(), debts) };
}

router.get('/funding-analysis', async (req, res, next) => {
  try { res.json((await fundingAnalysis()).plan); } catch (error) { next(error); }
});

router.get('/', async (req, res, next) => {
  try {
    const { goals, plan } = await fundingAnalysis();
    res.json(goals.map(goal => ({
      ...goal, target_amount: Number(goal.target_amount), current_amount: Number(goal.current_amount),
      ...plan.goals.find(row => row.id === goal.id),
      progress_pct: Number(goal.target_amount) > 0 ? Math.min(100, Number(goal.current_amount) / Number(goal.target_amount) * 100) : 0
    })));
  } catch (error) { next(error); }
});

function validatedGoal(input, partial = false) {
  const result = {};
  for (const key of ['name', 'target_amount', 'current_amount', 'target_date', 'priority', 'icon', 'color', 'notes', 'included', 'monthly_contribution', 'contribution_day']) {
    if (input[key] === undefined && partial) continue;
    const value = input[key];
    if (key === 'included') {
      if (value !== undefined && typeof value !== 'boolean') throw Object.assign(new Error('Choose whether the goal is in the plan'), { status: 400 });
      result[key] = value ?? true;
    } else if (key === 'monthly_contribution') {
      const number = value == null || value === '' ? null : Number(value);
      if (number != null && (!Number.isFinite(number) || number < 0 || number > 1e9)) throw Object.assign(new Error('Enter a valid monthly amount'), { status: 400 });
      result[key] = number;
    } else if (key === 'contribution_day') {
      const number = value == null || value === '' ? null : Number(value);
      if (number != null && (!Number.isInteger(number) || number < 1 || number > 31)) throw Object.assign(new Error('Contribution day must be between 1 and 31'), { status: 400 });
      result[key] = number;
    } else if (key === 'name') {
      if (typeof value !== 'string' || !value.trim() || value.length > 150) throw Object.assign(new Error('A goal name of up to 150 characters is required'), { status: 400 });
      result[key] = value.trim();
    } else if (['target_amount', 'current_amount', 'priority'].includes(key)) {
      const number = value === undefined && key === 'current_amount' ? 0 : value === undefined && key === 'priority' ? 1 : Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 1e10 || (key === 'target_amount' && number === 0)
          || (key === 'priority' && (!Number.isInteger(number) || number < 1 || number > 1000))) {
        throw Object.assign(new Error(`Invalid ${key}`), { status: 400 });
      }
      result[key] = number;
    } else if (key === 'target_date') {
      const parsed = value ? parseTxDate(value) : null;
      if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !parsed
          || parsed.year < 1900 || parsed.year > 2200
          || new Date(parsed.year, parsed.month, parsed.day).getMonth() !== parsed.month)) {
        throw Object.assign(new Error('Choose a valid target date'), { status: 400 });
      }
      result[key] = value || null;
    } else {
      if (value != null && (typeof value !== 'string' || value.length > 4000)) throw Object.assign(new Error(`Invalid ${key}`), { status: 400 });
      result[key] = value || (key === 'icon' ? 'Save' : key === 'color' ? '#369c85' : null);
    }
  }
  return result;
}

router.post('/', async (req, res, next) => {
  try {
    const goal = validatedGoal(req.body);
    const keys = Object.keys(goal);
    const result = await db.run(`INSERT INTO savings_goals (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(goal));
    res.json({ success: true, id: result.rows[0].id, message: 'Goal created' });
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const goal = validatedGoal(req.body, true);
    const keys = Object.keys(goal);
    if (!keys.length) return res.status(400).json({ error: 'No fields to update' });
    const result = await db.run(`UPDATE savings_goals SET ${keys.map((key, i) => `${key}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1} RETURNING id`, [...Object.values(goal), req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Goal not found' });
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.run('DELETE FROM savings_goals WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Goal not found' });
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.post('/:id/contribute', async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e10) return res.status(400).json({ error: 'A valid positive contribution is required' });
    const result = await db.run('UPDATE savings_goals SET current_amount=current_amount+$1 WHERE id=$2 RETURNING current_amount', [amount, req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Goal not found' });
    res.json({ success: true, current_amount: Number(result.rows[0].current_amount), message: 'Savings progress recorded; no bank transfer was made' });
  } catch (error) { next(error); }
});

export default router;
