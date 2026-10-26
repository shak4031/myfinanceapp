import { parseTxDate } from './normalize.js';
import { isTransferRow } from './transfers.js';
import { normalizeDebt, simulatePayoff } from './payoff.js';

const cents = value => Math.round(value * 100) / 100;
const fixed = value => [true, 1, 'true', '1'].includes(value);

export function buildDebtCoaching({ history, financial, debtPlan, goalPlan, now, flex = {} }) {
  const debts = debtPlan.debts.filter(debt => debt.included && debt.balance > 0).map(normalizeDebt);
  const months = financial.monthlyHistory.map(row => ({
    ...row, expenses: cents(row.expenses + financial.additionalDebtPayments),
    surplus: cents(row.surplus - financial.additionalDebtPayments)
  }));
  const observed = new Set(months.map(row => row.month));
  const surplus = financial.monthlySurplus;
  const currentExtra = Math.max(debtPlan.extra, Number(flex['debt-extra'] ?? debtPlan.extra));
  const goals = cents(goalPlan.goals.filter(goal => goal.included && goal.remaining > 0)
    .reduce((sum, goal) => sum + Math.max(goal.allocated, Number(flex[`goal:${goal.id}`] ?? goal.allocated)), 0));
  const weakest = months.length ? Math.min(...months.map(row => row.surplus)) : null;
  const buffer = surplus == null ? null : cents(Math.max(100, financial.avgMonthlyExpenses * 0.1));
  const remaining = surplus == null ? null : cents(surplus - goals - currentExtra);
  const tightMonthRemaining = weakest == null ? null : cents(weakest - goals - currentExtra);
  const capacity = surplus == null ? null : cents(Math.max(0, Math.min(surplus, weakest) - goals - currentExtra - buffer));
  const ready = months.length === 3 && months.every(row => row.income > 0 && row.expenses > 0)
    && debtPlan.plan.feasible && debts.length > 0;
  const supportedExtra = ready ? Math.floor(capacity / 25) * 25 : 0;
  const evaluate = extra => {
    const result = simulatePayoff(debts, { budget: cents(debtPlan.budget + extra), strategy: debtPlan.strategy, start: now });
    const first = result.payoffs.filter(row => row.month != null).sort((a, b) => a.month - b.month)[0] || null;
    return {
      extra, budget: cents(debtPlan.budget + extra), feasible: result.feasible, debtFree: result.debtFree,
      debtFreeDate: result.debtFreeDate, months: result.months, totalInterest: result.totalInterest,
      monthsSaved: result.debtFree && debtPlan.plan.debtFree ? debtPlan.plan.months - result.months : null,
      interestSaved: result.debtFree && debtPlan.plan.debtFree ? cents(debtPlan.plan.totalInterest - result.totalInterest) : null,
      firstWin: first && { name: first.name, month: first.month, date: first.date }
    };
  };
  const categories = new Map();
  for (const tx of history) {
    const date = parseTxDate(tx.date);
    const key = date && `${date.year}-${String(date.month + 1).padStart(2, '0')}`;
    const category = tx.category || 'Uncategorized';
    if (!observed.has(key) || String(tx.direction).toUpperCase() !== 'DEBIT'
      || isTransferRow(tx) || fixed(tx.is_fixed)
      || !/dining|restaurant|takeout|entertainment|shopping|subscription/i.test(category)
      || /loan|mortgage|debt|credit.card|medical|insurance|utilities/i.test(category)) continue;
    const amount = Number(tx.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const row = categories.get(category) || { category, total: 0, count: 0 };
    row.total += amount; row.count++;
    categories.set(category, row);
  }
  const opportunities = [...categories.values()].map(row => {
    const average = cents(row.total / months.length);
    const reduction = cents(average * 0.1);
    return {
      category: row.category, average, count: row.count, reduction,
      monthlyTarget: cents(average - reduction), weeklyTarget: cents((average - reduction) * 12 / 52),
      impact: evaluate(reduction)
    };
  }).filter(row => row.reduction >= 5).sort((a, b) => b.reduction - a.reduction).slice(0, 3);
  const payoffs = debtPlan.plan.payoffs.filter(row => row.month != null).sort((a, b) => a.month - b.month);
  const first = payoffs[0];
  const horizon = Math.min(3, Math.max(0, debtPlan.plan.series.length - 1));
  const firstDebt = first && debts.find(debt => debt.id === first.id);
  const strategyTradeoffs = debtPlan.comparison.filter(row => !row.locked).map(row => {
    const result = simulatePayoff(debts, { budget: debtPlan.budget, strategy: row.id, start: now });
    const win = result.payoffs.filter(item => item.month != null).sort((a, b) => a.month - b.month)[0];
    return {
      id: row.id, name: row.name, debtFree: result.debtFree, firstWin: win ? { name: win.name, month: win.month, date: win.date } : null,
      interestDifference: result.debtFree && debtPlan.plan.debtFree ? cents(result.totalInterest - debtPlan.plan.totalInterest) : null
    };
  });
  const status = !months.length ? 'needs-history' : !debtPlan.plan.feasible ? 'minimum-gap'
    : remaining < 0 || tightMonthRemaining < 0 ? 'stabilize' : !ready ? 'review-history' : supportedExtra > 0 ? 'room-to-accelerate' : 'protect-buffer';
  const increase = supportedExtra >= 25 ? evaluate(supportedExtra) : null;
  const suggested = increase?.debtFree && (!debtPlan.plan.debtFree || increase.monthsSaved > 0 || increase.interestSaved >= 1) ? increase : null;
  return {
    status, months, monthsUsed: months.length, averageIncome: financial.avgMonthlyIncome,
    averageExpenses: financial.avgMonthlyExpenses, recordedExpenses: financial.recordedAvgMonthlyExpenses,
    unrecordedMinimums: financial.additionalDebtPayments, surplus, weakestSurplus: weakest,
    goalContributions: goals, currentExtra, remaining, tightMonthRemaining, buffer, capacity,
    supportedExtra, suggested,
    scenarios: debts.length ? [25, 50, 100].map(extra => ({ ...evaluate(extra), supported: ready && extra <= capacity })) : [],
    opportunities: debts.length ? opportunities : [], strategyTradeoffs,
    milestones: {
      months: horizon,
      principalReduction: horizon ? cents(debtPlan.plan.series[0] - debtPlan.plan.series[horizon]) : null,
      firstWin: first ? { name: first.name, month: first.month, date: first.date, rolledMinimum: firstDebt?.min_payment || 0 } : null
    }
  };
}
