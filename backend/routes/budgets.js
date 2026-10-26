import { Router } from 'express';
import Database from '../db.js';
import { requirePro } from '../utils/license.js';

const router = Router();
const db = new Database();
const MAX_BUDGET = 10000000;

router.use(requirePro);

router.get('/', async (req, res, next) => {
  try {
    const rows = await db.all('SELECT category, monthly_amount FROM category_budgets ORDER BY category');
    res.json({ budgets: rows.map(row => ({ category: row.category, amount: Number(row.monthly_amount) })) });
  } catch (error) { next(error); }
});

// Replaces the full budget set; categories omitted or set to 0 are cleared.
router.put('/', async (req, res, next) => {
  try {
    const input = req.body?.budgets;
    if (!Array.isArray(input) || input.length > 500) return res.status(400).json({ error: 'budgets must be an array of at most 500 entries' });
    const budgets = new Map();
    for (const entry of input) {
      const category = typeof entry?.category === 'string' ? entry.category.trim().slice(0, 100) : '';
      const amount = Number(entry?.amount);
      if (!category || !Number.isFinite(amount) || amount < 0 || amount > MAX_BUDGET) {
        return res.status(400).json({ error: 'Each budget needs a category and an amount between 0 and 10,000,000' });
      }
      budgets.set(category, Math.round(amount * 100) / 100);
    }
    const saved = await db.transaction(async client => {
      await client.query('DELETE FROM category_budgets');
      for (const [category, amount] of budgets) {
        if (amount > 0) await client.query('INSERT INTO category_budgets (category, monthly_amount) VALUES ($1,$2)', [category, amount]);
      }
      return (await client.query('SELECT category, monthly_amount FROM category_budgets ORDER BY category')).rows;
    });
    res.json({ budgets: saved.map(row => ({ category: row.category, amount: Number(row.monthly_amount) })) });
  } catch (error) { next(error); }
});

export default router;
