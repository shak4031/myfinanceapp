import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';

const router = Router();
const db = new Database();

/**
 * GET /api/goals
 * List all goals with funding projections
 */
router.get('/', async (req, res) => {
  try {
    const goals = await db.all(
      'SELECT * FROM savings_goals WHERE user_id = 1 ORDER BY priority ASC, created_at ASC'
    );

    // Fetch funding projections for each goal
    const fundedGoals = await Promise.all(goals.map(async (g) => {
      const projection = await calculateGoalFunding(g);
      return {
        id: g.id,
        name: g.name,
        target_amount: parseFloat(g.target_amount) || 0,
        current_amount: parseFloat(g.current_amount) || 0,
        target_date: g.target_date,
        priority: g.priority,
        icon: g.icon,
        color: g.color,
        notes: g.notes,
        remaining: Math.max(0, (parseFloat(g.target_amount) || 0) - (parseFloat(g.current_amount) || 0)),
        progress_pct: g.target_amount > 0 ? ((parseFloat(g.current_amount) || 0) / parseFloat(g.target_amount) * 100).toFixed(1) : 0,
        ...projection
      };
    }));

    res.json(fundedGoals);
  } catch (err) {
    log('GOALS', `GET error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/goals
 * Create a new goal
 */
router.post('/', async (req, res) => {
  try {
    const { name, target_amount, current_amount, target_date, priority, icon, color, notes } = req.body;

    if (!name || !target_amount) {
      return res.status(400).json({ error: 'Name and target_amount are required' });
    }

    const result = await db.run(
      `INSERT INTO savings_goals 
       (user_id, name, target_amount, current_amount, target_date, priority, icon, color, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [1, name, parseFloat(target_amount) || 0, parseFloat(current_amount) || 0, target_date || null,
       priority || 1, icon || '\u{1f3af}', color || '#4a9eff', notes || null]
    );

    log('GOALS', `Created goal: ${name} ($${target_amount})`);
    res.json({ success: true, id: result?.rows?.[0]?.id || null, message: 'Goal created' });
  } catch (err) {
    log('GOALS', `POST error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/goals/:id
 * Update a goal
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, target_amount, current_amount, target_date, priority, icon, color, notes } = req.body;

    const updates = [];
    const values = [];
    let paramIdx = 1;

    if (name !== undefined) { updates.push(`name = $${paramIdx++}`); values.push(name); }
    if (target_amount !== undefined) { updates.push(`target_amount = $${paramIdx++}`); values.push(parseFloat(target_amount)); }
    if (current_amount !== undefined) { updates.push(`current_amount = $${paramIdx++}`); values.push(parseFloat(current_amount)); }
    if (target_date !== undefined) { updates.push(`target_date = $${paramIdx++}`); values.push(target_date); }
    if (priority !== undefined) { updates.push(`priority = $${paramIdx++}`); values.push(priority); }
    if (icon !== undefined) { updates.push(`icon = $${paramIdx++}`); values.push(icon); }
    if (color !== undefined) { updates.push(`color = $${paramIdx++}`); values.push(color); }
    if (notes !== undefined) { updates.push(`notes = $${paramIdx++}`); values.push(notes); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    await db.run(
      `UPDATE savings_goals SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      values
    );

    log('GOALS', `Updated goal ${id}`);
    res.json({ success: true, message: 'Goal updated' });
  } catch (err) {
    log('GOALS', `PUT error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/goals/:id
 * Delete a goal
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM savings_goals WHERE id = $1', [id]);
    log('GOALS', `Deleted goal ${id}`);
    res.json({ success: true, message: 'Goal deleted' });
  } catch (err) {
    log('GOALS', `DELETE error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/goals/:id/contribute
 * Contribute money to a goal
 */
router.post('/:id/contribute', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Valid positive amount required' });
    }

    await db.run(
      'UPDATE savings_goals SET current_amount = current_amount + $1 WHERE id = $2',
      [parseFloat(amount), id]
    );

    const updated = await db.get('SELECT * FROM savings_goals WHERE id = $1', [id]);
    log('GOALS', `Contributed $${amount} to goal ${id}`);
    res.json({ success: true, current_amount: updated.current_amount });
  } catch (err) {
    log('GOALS', `Contribute error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/goals/funding-analysis
 * Income vs spending analysis for all goals
 */
router.get('/funding-analysis', async (req, res) => {
  try {
    const analysis = await computeFundingAnalysis();
    res.json(analysis);
  } catch (err) {
    log('GOALS', `Analysis error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Calculate projected funding for a single goal based on:
 * - Monthly income (from transactions direction=CREDIT)
 * - Monthly spending (from transactions direction=DEBIT)
 * - Target date deadline
 * - Current progress
 */
async function calculateGoalFunding(goal) {
  try {
    // 1. Get last 3 months of income and expenses for trend
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const cutoffDate = threeMonthsAgo.toISOString().split('T')[0];

    // Monthly average income (salary, deposits, etc)
    const incomeRes = await db.get(
      `SELECT COALESCE(AVG(monthly_income), 0) as avg_income FROM (
        SELECT 
          DATE_TRUNC('month', date::date) as month,
          SUM(amount) as monthly_income
        FROM transactions
        WHERE direction = 'CREDIT' AND date >= $1 AND user_id = 1
          AND NOT (description ILIKE '%transfer%' OR description ILIKE '%xfer%')
        GROUP BY DATE_TRUNC('month', date::date)
      ) income_months`,
      [cutoffDate]
    );

    const avgIncome = parseFloat(incomeRes?.avg_income) || 5000; // fallback

    // Monthly average spending (debits)
    const expenseRes = await db.get(
      `SELECT COALESCE(AVG(monthly_expense), 0) as avg_expense FROM (
        SELECT 
          DATE_TRUNC('month', date::date) as month,
          SUM(amount) as monthly_expense
        FROM transactions
        WHERE direction = 'DEBIT' AND date >= $1 AND user_id = 1
          AND category NOT IN ('Savings', 'Transfer')
        GROUP BY DATE_TRUNC('month', date::date)
      ) expense_months`,
      [cutoffDate]
    );

    const avgExpense = parseFloat(expenseRes?.avg_expense) || 3500; // fallback

    // Discretionary = what could go to goals
    const monthlyDiscretionary = Math.max(0, avgIncome - avgExpense);

    // Calculate how many months until target
    let monthsUntil = 12; // default
    if (goal.target_date) {
      const target = new Date(goal.target_date);
      const now = new Date();
      monthsUntil = Math.max(1, (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth()));
    }

    const targetAmount = parseFloat(goal.target_amount) || 0;
    const currentAmount = parseFloat(goal.current_amount) || 0;
    const remaining = Math.max(0, targetAmount - currentAmount);

    // Calculate suggested monthly contribution
    const suggestedMonthly = monthsUntil > 0 ? remaining / monthsUntil : 0;

    // Is it achievable?
    const achievable = suggestedMonthly <= monthlyDiscretionary;
    const monthlyShortfall = achievable ? 0 : Math.max(0, suggestedMonthly - monthlyDiscretionary);

    // Projected completion date based on available discretionary
    const projectedMonths = (monthlyDiscretionary > 0 && remaining > 0) ? Math.ceil(remaining / monthlyDiscretionary) : (remaining <= 0 ? 0 : 999);
    const projectedDate = new Date();
    if (remaining <= 0) {
      projectedDate.setDate(projectedDate.getDate());
    } else {
      projectedDate.setMonth(projectedDate.getMonth() + projectedMonths);
    }

    return {
      monthly_income: parseFloat(avgIncome.toFixed(2)),
      monthly_expense: parseFloat(avgExpense.toFixed(2)),
      monthly_discretionary: parseFloat(monthlyDiscretionary.toFixed(2)),
      suggested_monthly: parseFloat(suggestedMonthly.toFixed(2)),
      achievable,
      monthly_shortfall: parseFloat(monthlyShortfall.toFixed(2)),
      projected_months: projectedMonths,
      projected_date: remaining <= 0 ? new Date().toISOString().split('T')[0] : projectedDate.toISOString().split('T')[0],
      months_until_target: monthsUntil
    };

  } catch (err) {
    log('GOALS', `Funding calc error: ${err.message}`);
    return {
      monthly_income: 0, monthly_expense: 0, monthly_discretionary: 0,
      suggested_monthly: 0, achievable: false, monthly_shortfall: 0,
      projected_months: 999, projected_date: null, months_until_target: 12
    };
  }
}

/**
 * Compute overall funding analysis across all goals
 */
async function computeFundingAnalysis() {
  try {
    const goals = await db.all('SELECT * FROM savings_goals WHERE user_id = 1 ORDER BY priority ASC');
    const analysis = await Promise.all(goals.map(g => calculateGoalFunding(g)));

    const totalRemaining = goals.reduce((s, g) => s + Math.max(0, parseFloat(g.target_amount) - parseFloat(g.current_amount || 0)), 0);
    const totalSuggested = analysis.reduce((s, a) => s + a.suggested_monthly, 0);
    const totalDiscretionary = analysis.length > 0 ? analysis[0].monthly_discretionary : 0;

    return {
      total_goals: goals.length,
      total_remaining: parseFloat(totalRemaining.toFixed(2)),
      total_suggested_monthly: parseFloat(totalSuggested.toFixed(2)),
      total_discretionary: parseFloat(totalDiscretionary.toFixed(2)),
      gap: parseFloat((totalSuggested - totalDiscretionary).toFixed(2)),
      summary: totalSuggested <= totalDiscretionary
        ? "\u2705 Your discretionary income covers all goal contributions!"
        : "\u26a0\ufe0f You need to increase income or reduce spending to meet all goals on time.",
      goals: goals.map((g, i) => ({
        name: g.name,
        target: parseFloat(g.target_amount),
        current: parseFloat(g.current_amount || 0),
        remaining: parseFloat((g.target_amount - (g.current_amount || 0)).toFixed(2)),
        target_date: g.target_date,
        ...analysis[i]
      }))
    };
  } catch (err) {
    return { error: err.message };
  }
}

export default router;
