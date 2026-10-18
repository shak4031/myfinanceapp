import { parseTxDate } from './normalize.js';
import { isTransferRow } from './transfers.js';

const cents = value => Math.round(value * 100) / 100;
// Rows loaded with transfer_kind use the account-aware classification; older callers fall back to wording.
const isTransfer = tx => Object.prototype.hasOwnProperty.call(tx, 'transfer_kind') ? isTransferRow(tx)
  : /^(?:transfer|transfers|savings)$/i.test(tx.category || '')
    || /\b(?:internal\s+transfer|transfer\s+(?:to|from)|xfer)\b/i.test(tx.description || '');

export function buildFinancialPlan(transactions, goals, today = new Date(), debts = []) {
  const month = today.getFullYear() * 12 + today.getMonth();
  const buckets = new Map();
  const categories = new Map();
  for (const tx of transactions) {
    const date = parseTxDate(tx.date);
    if (!date) throw new Error(`Invalid date in transaction ${tx.id}`);
    const offset = month - (date.year * 12 + date.month);
    if (offset < 1 || offset > 3 || isTransfer(tx)) continue;
    const amount = Number(tx.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid amount in transaction ${tx.id}`);
    const key = `${date.year}-${date.month}`;
    if (!buckets.has(key)) buckets.set(key, { month: `${date.year}-${String(date.month + 1).padStart(2, '0')}`, income: 0, expenses: 0 });
    const bucket = buckets.get(key);
    if (String(tx.direction).toUpperCase() === 'CREDIT') bucket.income += amount;
    else if (String(tx.direction).toUpperCase() === 'DEBIT') {
      bucket.expenses += amount;
      const category = tx.category || 'Uncategorized';
      categories.set(category, (categories.get(category) || 0) + amount);
    }
  }
  const monthsUsed = buckets.size;
  const avgMonthlyIncome = monthsUsed ? cents([...buckets.values()].reduce((s, b) => s + b.income, 0) / monthsUsed) : null;
  const recordedAvgMonthlyExpenses = monthsUsed ? cents([...buckets.values()].reduce((s, b) => s + b.expenses, 0) / monthsUsed) : null;
  const additionalDebtPayments = cents(debts.filter(debt => debt.payment_in_history === false).reduce((sum, debt) => sum + Number(debt.min_payment || 0), 0));
  const avgMonthlyExpenses = monthsUsed ? cents(recordedAvgMonthlyExpenses + additionalDebtPayments) : null;
  const monthlySurplus = monthsUsed ? cents(avgMonthlyIncome - avgMonthlyExpenses) : null;
  const savingsRate = avgMonthlyIncome > 0 ? cents(monthlySurplus / avgMonthlyIncome * 100) : null;
  const monthlyHistory = [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month)).map(row => ({
    month: row.month, income: cents(row.income), expenses: cents(row.expenses), surplus: cents(row.income - row.expenses)
  }));
  let allocatable = Math.max(0, monthlySurplus || 0);
  const sortedGoals = [...goals].sort((a, b) => Number(a.priority) - Number(b.priority) || Number(a.id) - Number(b.id));
  const plannedGoals = sortedGoals.map(goal => {
    const remaining = cents(Math.max(0, Number(goal.target_amount) - Number(goal.current_amount)));
    const date = parseTxDate(goal.target_date);
    const deadline = date ? new Date(date.year, date.month, date.day) : null;
    const expired = deadline && deadline < new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const monthsRemaining = date ? Math.max(1, (date.year * 12 + date.month) - month) : null;
    const requiredMonthly = remaining === 0 ? 0 : monthsRemaining ? cents(Math.ceil(remaining * 100 / monthsRemaining) / 100) : null;
    const allocatedMonthly = cents(Math.min(allocatable, requiredMonthly || 0));
    allocatable = cents(allocatable - allocatedMonthly);
    const status = remaining === 0 ? 'funded' : !deadline ? 'needs-deadline' : expired ? 'overdue'
      : !monthsUsed ? 'insufficient-data' : allocatedMonthly >= requiredMonthly ? 'on-track' : 'shortfall';
    const shortfall = requiredMonthly === null ? null : cents(Math.max(0, requiredMonthly - allocatedMonthly));
    return {
      id: goal.id, name: goal.name, remaining, monthsRemaining, requiredMonthly, allocatedMonthly, status,
      target: Number(goal.target_amount), current: Number(goal.current_amount), target_date: goal.target_date,
      suggested_monthly: requiredMonthly, achievable: status === 'on-track' || status === 'funded',
      monthly_shortfall: shortfall, monthly_discretionary: monthlySurplus, months_until_target: monthsRemaining,
      monthly_income: avgMonthlyIncome, monthly_expense: avgMonthlyExpenses,
      projected_months: allocatedMonthly > 0 ? Math.ceil(remaining / allocatedMonthly) : null,
      projected_date: null
    };
  });
  const requiredMonthlySavings = cents(plannedGoals.reduce((sum, g) => sum + (g.requiredMonthly || 0), 0));
  const availableAfterGoals = monthsUsed ? cents(monthlySurplus - requiredMonthlySavings) : null;
  const categorySpending = [...categories].map(([category, total]) => ({
    category, total: cents(total), monthlyAverage: cents(total / monthsUsed)
  })).sort((a, b) => b.monthlyAverage - a.monthlyAverage);
  const advice = [];
  if (!monthsUsed) advice.push({ title: 'Import history before making commitments', detail: 'No completed-month history is available. Affordability is unknown, not zero-cost or automatically affordable.', severity: 'warning' });
  else {
    if (additionalDebtPayments > 0) advice.push({
      title: 'New debt payments reduce what you can save',
      detail: `$${additionalDebtPayments.toFixed(2)} per month is reserved for debts marked as not yet included in imported spending. Update that setting after those payments appear in your history to avoid counting them twice.`, severity: 'info'
    });
    const rate = avgMonthlyIncome > 0 ? monthlySurplus / avgMonthlyIncome * 100 : 0;
    if (monthlySurplus <= 0) advice.push({
      title: 'Your current spending leaves no room for new goals',
      detail: `Monthly outflows average $${avgMonthlyExpenses.toFixed(2)} against $${avgMonthlyIncome.toFixed(2)} of recorded inflows. Delay optional purchases and cut recurring spending before taking on another payment.`, severity: 'danger'
    });
    else if (rate < 10) advice.push({
      title: 'A high income is not a financial cushion',
      detail: `Only ${rate.toFixed(1)}% of recorded income remains after spending. Set a weekly discretionary limit and automate a realistic savings transfer after essential bills.`, severity: 'warning'
    });
    if (availableAfterGoals < 0) advice.push({
      title: 'These deadlines compete for the same money',
      detail: `Your goals need $${requiredMonthlySavings.toFixed(2)} per month, exceeding observed surplus by $${Math.abs(availableAfterGoals).toFixed(2)}. Reduce a target, move a date, or cut spending; the app will not count the same surplus twice.`, severity: 'danger'
    });
    if (monthlyHistory.length > 1) {
      const latest = monthlyHistory[monthlyHistory.length - 1];
      const earlier = monthlyHistory.slice(0, -1);
      const baselineIncome = earlier.reduce((sum, row) => sum + row.income, 0) / earlier.length;
      const baselineExpenses = earlier.reduce((sum, row) => sum + row.expenses, 0) / earlier.length;
      if (latest.income > baselineIncome && latest.expenses - baselineExpenses >= latest.income - baselineIncome) {
        advice.push({
          title: 'Your spending absorbed the increase in recorded income',
          detail: `In ${latest.month}, inflows rose by $${cents(latest.income - baselineIncome).toFixed(2)} versus the earlier observed-month average, while outflows rose by $${cents(latest.expenses - baselineExpenses).toFixed(2)}. The extra income did not improve your cushion. Freeze discretionary upgrades until your reserve is growing. Imports may be incomplete; this comparison does not prove a salary raise.`, severity: 'warning'
        });
      }
    }
    const discretionary = categorySpending.filter(row => /dining|shopping|entertainment|subscription/i.test(row.category));
    if (discretionary.length) {
      const total = cents(discretionary.reduce((sum, row) => sum + row.monthlyAverage, 0));
      advice.push({
        title: 'Start with the spending you can actually change',
        detail: `${discretionary.map(row => row.category).join(', ')} total $${total.toFixed(2)} per month. A 20% reduction would free about $${cents(total * 0.2).toFixed(2)}; this is a proposed cut, not guaranteed savings.`, severity: 'info'
      });
    }
    advice.push({
      title: 'Protect an emergency reserve before upgrading your lifestyle',
      detail: `Use actual essential expenses to set your reserve target. Three months of all recorded outflows is $${cents(avgMonthlyExpenses * 3).toFixed(2)} as a conservative reference, not an automatic recommendation. Keep this reserve separate from car and college goals.`, severity: 'info'
    });
  }
  return {
    avgMonthlyIncome, avgMonthlyExpenses, monthlySurplus, requiredMonthlySavings, availableAfterGoals,
    monthsUsed, savingsRate, monthlyHistory, recordedAvgMonthlyExpenses, additionalDebtPayments, goals: plannedGoals, categorySpending, advice,
    basis: 'Local calculations from up to three completed calendar months with imported records. Transfers excluded; missing months are not assumed to be zero. Income is recorded cash inflow, not gross salary. Partial data can overstate affordability. Debt minimums marked as not included in history are reserved separately; other debt payments are assumed to be in imported spending. Other unrecorded obligations are not included.',
    total_goals: goals.length, total_remaining: cents(plannedGoals.reduce((sum, g) => sum + g.remaining, 0)),
    total_suggested_monthly: requiredMonthlySavings, total_discretionary: monthlySurplus,
    gap: availableAfterGoals === null ? null : -availableAfterGoals,
    summary: !monthsUsed ? 'Import completed-month history to assess your plan.'
      : availableAfterGoals < 0 ? 'Your goals exceed observed surplus. Change spending, targets, or deadlines.'
      : 'Your recorded surplus covers dated goals; verify your emergency reserve and unrecorded obligations.'
  };
}
