import { Router } from 'express';
import Database from '../db.js';
import { getEntitlement, requirePro } from '../utils/license.js';
import { strategyIds, DEBT_STRATEGIES, monthKey } from '../utils/payoff.js';
import { goalStrategyIds, GOAL_STRATEGIES, normalizeGoal, simulateGoals } from '../utils/goalPlan.js';
import { FLEX_KEY, buildPlanPayments, computePlan, loadPlanInputs, normalizeSettings } from '../utils/moneyPlan.js';

const router = Router();
const db = new Database();
const badRequest = message => Object.assign(new Error(message), { status: 400 });

async function currentPlan(req, options = {}) {
  const now = new Date();
  const [inputs, entitlement] = await Promise.all([loadPlanInputs(db, now), getEntitlement(req.user.id)]);
  const pro = !!entitlement.active;
  return { inputs, pro, now, plan: computePlan(inputs, { pro, now, ...options }) };
}

function respond(plan, pro, now) {
  const { incomeItems, ...rest } = plan;
  return { ...rest, pro, thisMonth: buildPlanPayments(plan, now), flex: plan.settings.flex?.[plan.month] || {} };
}

router.get('/', async (req, res, next) => {
  try {
    const { plan, pro, now } = await currentPlan(req);
    res.json(respond(plan, pro, now));
  } catch (error) { next(error); }
});

const amountOrNull = (value, label) => {
  if (value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1e9) throw badRequest(`Enter a valid ${label}`);
  return Math.round(number * 100) / 100;
};

async function saveSettings(changes) {
  const keys = Object.keys(changes);
  const values = Object.values(changes).map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
  await db.run(`INSERT INTO money_plans (${keys.join(',')}, updated_at) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET ${keys.map(key => `${key}=EXCLUDED.${key}`).join(',')}, updated_at=NOW()`, values);
}

router.put('/settings', async (req, res, next) => {
  try {
    const body = req.body || {}, changes = {};
    const proOnly = [];
    if (body.debt_strategy !== undefined) {
      if (!strategyIds.includes(body.debt_strategy)) throw badRequest('Choose a valid payoff strategy');
      if (DEBT_STRATEGIES.find(item => item.id === body.debt_strategy).pro) proOnly.push(body.debt_strategy);
      changes.debt_strategy = body.debt_strategy;
    }
    if (body.goal_strategy !== undefined) {
      if (!goalStrategyIds.includes(body.goal_strategy)) throw badRequest('Choose a valid goal strategy');
      if (GOAL_STRATEGIES.find(item => item.id === body.goal_strategy).pro) proOnly.push(body.goal_strategy);
      changes.goal_strategy = body.goal_strategy;
    }
    if (body.debt_budget !== undefined) changes.debt_budget = amountOrNull(body.debt_budget, 'monthly debt budget');
    if (body.goal_budget !== undefined) changes.goal_budget = amountOrNull(body.goal_budget, 'monthly goals budget');
    if (!Object.keys(changes).length) throw badRequest('No settings to update');
    if (proOnly.length) {
      const entitlement = await getEntitlement(req.user.id);
      if (!entitlement.active) return res.status(402).json({ error: 'This strategy is part of MyFinance Pro', code: 'PRO_REQUIRED', entitlement });
    }
    await saveSettings(changes);
    const { plan, pro, now } = await currentPlan(req);
    res.json(respond(plan, pro, now));
  } catch (error) { next(error); }
});

// Flexible amounts are per month, so a tight month never rewrites the long-term plan.
router.put('/flex', async (req, res, next) => {
  try {
    const { key } = req.body || {};
    const month = req.body?.month || monthKey(new Date(), 0);
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw badRequest('Choose a valid month');
    if (typeof key !== 'string' || !FLEX_KEY.test(key)) throw badRequest('Choose a valid plan item');
    const amount = amountOrNull(req.body?.amount ?? null, 'amount');
    const oldest = monthKey(new Date(), -1);
    await db.transaction(async client => {
      const row = (await client.query('SELECT flex FROM money_plans LIMIT 1 FOR UPDATE')).rows[0];
      const flex = Object.fromEntries(Object.entries(normalizeSettings(row).flex).filter(([name]) => name >= oldest));
      const entries = { ...(flex[month] || {}) };
      if (amount == null) delete entries[key]; else entries[key] = amount;
      if (Object.keys(entries).length) flex[month] = entries; else delete flex[month];
      await client.query(`INSERT INTO money_plans (flex, updated_at) VALUES ($1::jsonb, NOW())
        ON CONFLICT (user_id) DO UPDATE SET flex=EXCLUDED.flex, updated_at=NOW()`, [JSON.stringify(flex)]);
    });
    const { plan, pro, now } = await currentPlan(req);
    res.json(respond(plan, pro, now));
  } catch (error) { next(error); }
});

router.post('/what-if', requirePro, async (req, res, next) => {
  try {
    const body = req.body || {};
    const extra = amountOrNull(body.extra ?? 0, 'extra amount') || 0;
    const lumpSum = amountOrNull(body.lumpSum ?? 0, 'one-time amount') || 0;
    const { plan, inputs, now } = await currentPlan(req, { whatIf: { extra, lumpSum } });
    let goal = null;
    if (body.goalId != null) {
      const row = inputs.goals.find(item => String(item.id) === String(body.goalId));
      if (!row) return res.status(404).json({ error: 'Goal not found' });
      const monthly = amountOrNull(body.goalMonthly, 'monthly amount');
      if (monthly == null) throw badRequest('Enter a monthly amount');
      const normalized = { ...normalizeGoal(row, now), manual: monthly, included: true };
      const result = simulateGoals([normalized], { budget: monthly, start: now }).get(normalized.id);
      const finishMonth = normalized.remaining === 0 ? 0 : result?.finishMonth ?? null;
      goal = { id: row.id, monthly, finishMonth, finishDate: finishMonth == null ? null : monthKey(now, Math.max(0, finishMonth - 1)),
        onTime: normalized.targetMonth == null || (finishMonth != null && finishMonth <= Math.max(1, normalized.targetMonth)) };
    }
    res.json({ debt: plan.debtPlan.scenario, goal });
  } catch (error) { next(error); }
});

router.put('/debt-order', requirePro, async (req, res, next) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => !Number.isInteger(Number(id)))) throw badRequest('Provide the debts in the order to pay them');
    await db.transaction(async client => {
      await client.query('UPDATE credit_cards SET custom_rank = NULL');
      for (const [index, id] of ids.entries()) await client.query('UPDATE credit_cards SET custom_rank=$1 WHERE id=$2', [index + 1, Number(id)]);
    });
    await saveSettings({ debt_strategy: 'custom' });
    const { plan, pro, now } = await currentPlan(req);
    res.json(respond(plan, pro, now));
  } catch (error) { next(error); }
});

export default router;
