import { buildFinancialPlan } from './financialPlan.js';
import { buildDebtPlan, monthKey } from './payoff.js';
import { buildGoalPlan } from './goalPlan.js';
import { normalizeGoalPurchase } from './goalPurchases.js';
import { projectIncome } from './income.js';
import { buildDebtCoaching } from './debtCoaching.js';

const cents = value => Math.round(value * 100) / 100;
const dateString = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const FLEX_KEY = /^(?:debt-extra|goal:\d{1,9})$/;
export const DEFAULT_SETTINGS = Object.freeze({ debt_strategy: 'avalanche', debt_budget: null, goal_strategy: 'priority', goal_budget: null, flex: {} });

export function normalizeSettings(row) {
  if (!row) return { ...DEFAULT_SETTINGS, flex: {} };
  const number = value => value == null ? null : Number(value);
  return {
    debt_strategy: row.debt_strategy || 'avalanche', debt_budget: number(row.debt_budget),
    goal_strategy: row.goal_strategy || 'priority', goal_budget: number(row.goal_budget),
    flex: row.flex && typeof row.flex === 'object' ? row.flex : {}
  };
}

// One read-only round trip for everything the planner needs.
export async function loadPlanInputs(db, now = new Date()) {
  const recentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 200);
  return db.transaction(async client => {
    const debts = (await client.query('SELECT * FROM credit_cards ORDER BY apr DESC NULLS LAST, id')).rows;
    const goals = (await client.query('SELECT * FROM savings_goals ORDER BY priority, id')).rows;
    const purchases = (await client.query(`SELECT p.*, p.purchase_date::text AS purchase_date, p.payment_date::text AS payment_date,
      g.name AS goal_name FROM goal_purchases p
      JOIN savings_goals g ON g.id=p.goal_id AND g.user_id=p.user_id ORDER BY p.payment_date,p.id`)).rows.map(normalizeGoalPurchase);
    const settings = (await client.query('SELECT * FROM money_plans LIMIT 1')).rows[0];
    const history = (await client.query(`
      SELECT id, date, description, category, direction, amount, transfer_kind, is_fixed FROM transactions
      WHERE date::date >= (date_trunc('month', $1::date) - INTERVAL '3 months')::date
        AND date::date < date_trunc('month', $1::date)::date`, [dateString(now)])).rows;
    const recent = (await client.query(`
      SELECT id, date, description, category, direction, amount, is_fixed, pay_mode, income_role FROM transactions
      WHERE direction = 'CREDIT' AND transfer_kind IS NULL AND date::date >= $1::date AND date::date <= $2::date`, [dateString(recentStart), dateString(now)])).rows;
    return { debts, goals, purchases, settings: normalizeSettings(settings), history, recent };
  });
}

// The one "typical monthly surplus" every page shows: last 3 full months, transfers excluded,
// plus minimum payments for debts not yet visible in the imported history.
export function typicalSurplus({ debts = [], history = [] }, now = new Date()) {
  const active = debts.filter(debt => Number(debt.balance) > 0);
  const financial = buildFinancialPlan(history, [], now, active);
  return {
    avgMonthlyIncome: financial.avgMonthlyIncome, avgMonthlyExpenses: financial.avgMonthlyExpenses,
    monthlySurplus: financial.monthlySurplus, monthsUsed: financial.monthlyHistory.length,
    months: financial.monthlyHistory.map(row => row.month)
  };
}

export function computePlan({ debts, goals, purchases = [], settings, history, recent }, { pro = false, now = new Date(), whatIf = null } = {}) {
  const active = debts.filter(debt => Number(debt.balance) > 0);
  const financial = buildFinancialPlan(history, goals, now, active);
  const surplus = financial.monthlySurplus;
  const income = projectIncome(recent, now);
  const defaultContributionDay = income.items.map(item => item.dayOfMonth).sort((a, b) => a - b)[0] || 1;
  const hasEmergencyGoal = goals.some(goal => /emergency|rainy/i.test(goal.name || '') || /^\[plan:emergency\]/.test(goal.notes || ''));
  const debtPlan = buildDebtPlan({ debts, settings, pro, now, whatIf, hasEmergencyGoal });
  // The surplus already includes recorded minimums, so only the extra debt payment competes with goals.
  const available = surplus == null ? null : cents(surplus - debtPlan.extra);
  const priciest = debtPlan.debts.filter(debt => debt.included && debt.balance > 0 && debt.apr >= 15).sort((a, b) => b.apr - a.apr)[0];
  const goalPlan = buildGoalPlan({
    goals, settings, available, monthlyExpenses: financial.avgMonthlyExpenses, pro, now,
    highAprDebt: priciest ? { name: priciest.name, apr: priciest.apr } : null, defaultContributionDay
  });
  const coaching = buildDebtCoaching({ history, financial, debtPlan, goalPlan, now, flex: settings.flex?.[monthKey(now)] || {} });
  debtPlan.coaching = coaching;
  debtPlan.suggestion = coaching.suggested?.debtFree ? coaching.suggested : null;
  return {
    month: monthKey(now, 0),
    summary: {
      avgMonthlyIncome: financial.avgMonthlyIncome, avgMonthlyExpenses: financial.avgMonthlyExpenses,
      monthlySurplus: surplus, savingsRate: financial.savingsRate, monthsUsed: financial.monthlyHistory.length,
      debtExtra: debtPlan.extra, goalBudget: goalPlan.budget, available,
      unassigned: surplus == null ? null : cents(surplus - debtPlan.extra - goalPlan.allocatedTotal)
    },
    income: { streams: income.streams },
    incomeItems: income.items,
    debtPlan, goalPlan, purchases, settings, defaultContributionDay
  };
}

// Flexible calendar entries for this month: the debt-free program's extra payment and each goal contribution.
export function buildPlanPayments(plan, today = new Date()) {
  const month = monthKey(today, 0);
  const flex = plan.settings.flex?.[month] || {};
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const day = value => Math.min(Math.max(1, Number(value) || 1), monthEnd);
  const status = dayOfMonth => dayOfMonth < today.getDate() ? 'processed' : 'projected';
  const items = [];
  const included = plan.debtPlan.debts.filter(debt => debt.included && debt.balance > 0);

  for (const debt of included.filter(item => !item.payment_in_history && item.thisMonth.minimum > 0)) {
    const dayOfMonth = day(debt.due_day);
    items.push({
      key: `debt-min:${debt.id}`, planKind: 'debt-minimum', planned: true, flexible: false,
      description: `${debt.name} minimum`, category: 'Debt-free program', label: debt.name, amount: debt.thisMonth.minimum,
      dayOfMonth, isIncome: false, status: status(dayOfMonth), payMode: null
    });
  }

  const planned = cents(included.reduce((sum, debt) => sum + (debt.thisMonth.extra || 0), 0));
  if (included.length && (planned > 0 || flex['debt-extra'] != null)) {
    const target = included.find(debt => debt.thisMonth.extra > 0) || included[0];
    const amount = flex['debt-extra'] != null ? Number(flex['debt-extra']) : planned;
    const dayOfMonth = day(target.due_day);
    items.push({
      key: 'debt-extra', planKey: 'debt-extra', planKind: 'debt-extra', planned: true, flexible: true,
      description: `Extra payment · ${target.name}`, category: 'Debt-free program', label: `Extra · ${target.name}`, amount: cents(amount),
      defaultAmount: planned, adjusted: flex['debt-extra'] != null, dayOfMonth, isIncome: false, status: status(dayOfMonth), payMode: null
    });
  }

  const payday = plan.incomeItems.map(item => item.dayOfMonth).sort((a, b) => a - b)[0] || 1;
  for (const goal of plan.goalPlan.goals.filter(item => item.included && item.remaining > 0)) {
    const key = `goal:${goal.id}`;
    const allocation = month > plan.month ? (goal.monthlyAllocation ?? goal.allocated) : goal.allocated;
    if (!(allocation > 0) && flex[key] == null) continue;
    const amount = flex[key] != null ? Number(flex[key]) : allocation;
    const dayOfMonth = day(goal.contributionDay || payday);
    items.push({
      key, planKey: key, planKind: 'goal', planned: true, flexible: true, goalId: goal.id,
      description: `${goal.name} savings`, category: 'Savings goal', label: goal.name, amount: cents(amount),
      defaultAmount: allocation, adjusted: flex[key] != null, dayOfMonth, isIncome: false, status: status(dayOfMonth), payMode: null
    });
  }
  return items.sort((a, b) => a.dayOfMonth - b.dayOfMonth);
}
