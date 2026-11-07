import { parseTxDate } from './normalize.js';
import { isTransferRow } from './transfers.js';
import { isIncomeTransaction, detectIncomeStreams } from './income.js';
import { merchantGroup, merchantLabel } from './analytics.js';

const discretionary = /^(dining|dining out|eating out|restaurants?|shopping|entertainment|travel|recreation|hobbies)$/i;
const round = value => Math.round(value * 100) / 100;
const index = date => date.getFullYear() * 12 + date.getMonth();
const monthKey = value => `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, '0')}`;
const groupTotals = (rows, key, label = key) => {
  const groups = new Map();
  for (const row of rows) {
    const name = key(row);
    const entry = groups.get(name) || { name: label(row), amount: 0, count: 0 };
    entry.amount += row.amount;
    entry.count++;
    groups.set(name, entry);
  }
  return [...groups.values()].map(row => ({ ...row, amount: round(row.amount) })).sort((a, b) => b.amount - a.amount);
};

export function buildFinancialFindings({ transactions = [], today = new Date() } = {}) {
  const current = index(today);
  const rows = transactions.flatMap(tx => {
    const date = parseTxDate(tx.date);
    const amount = Math.abs(Number(tx.amount));
    if (!date || !Number.isFinite(amount) || !amount || tx.is_pending || isTransferRow(tx)) return [];
    const valid = new Date(date.year, date.month, date.day);
    if (valid.getFullYear() !== date.year || valid.getMonth() !== date.month || valid.getDate() !== date.day || valid > today) return [];
    const direction = String(tx.direction).toUpperCase();
    if (!['DEBIT', 'CREDIT'].includes(direction)) return [];
    return [{ ...tx, amount, direction, category: String(tx.category || 'Other').trim() || 'Other', iso: date.iso, month: date.year * 12 + date.month }];
  });
  // Empty calendar months are unknown: never silently count them as zero.
  const history = rows.filter(row => row.month >= current - 12 && row.month < current);
  const months = [...new Set(history.map(row => row.month))].sort((a, b) => a - b);
  const spend = history.filter(row => row.direction === 'DEBIT');
  const income = history.filter(isIncomeTransaction);
  const totalSpend = round(spend.reduce((sum, row) => sum + row.amount, 0));
  const totalIncome = round(income.reduce((sum, row) => sum + row.amount, 0));
  const incomeMonths = new Set(income.map(row => row.month)).size;
  const observedMonthlyIncome = incomeMonths ? round(totalIncome / incomeMonths) : null;
  const paychecksPerYear = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
  // Provider suffix variants should not split a paycheck source in this estimate.
  const payRows = rows.filter(isIncomeTransaction).map(row => ({
    ...row, description: row.description?.replace(/\b(?:BANK\s+)?(?:PAYROLL|PAY|SALARY|PAYCHECK|WAGES)\s*$/i, '').trim() || row.description
  }));
  const streams = detectIncomeStreams(payRows, today).map(stream => ({
    name: stream.name, amount: stream.amount, cadence: stream.cadence, label: stream.label,
    lastDate: stream.lastDate, occurrences: stream.occurrences,
    paychecksPerYear: paychecksPerYear[stream.cadence],
    annualIncome: round(stream.amount * paychecksPerYear[stream.cadence])
  }));
  const annualIncome = streams.length ? round(streams.reduce((sum, stream) => sum + stream.annualIncome, 0))
    : observedMonthlyIncome === null ? null : round(observedMonthlyIncome * 12);
  const monthlyIncome = annualIncome === null ? null : round(annualIncome / 12);
  const monthlySpend = months.length ? round(totalSpend / months.length) : null;
  const categories = groupTotals(spend, row => row.category);
  const merchants = groupTotals(spend, merchantGroup, merchantLabel);
  const extras = spend.filter(row => discretionary.test(row.category));
  const extraTotal = round(extras.reduce((sum, row) => sum + row.amount, 0));
  const extraCategories = groupTotals(extras, row => row.category);
  const extraMerchants = groupTotals(extras, merchantGroup, merchantLabel);
  return {
    period: { from: months.length ? monthKey(months[0]) : null, to: months.length ? monthKey(months.at(-1)) : null, months: months.length },
    monthlyIncome, annualIncome, observedMonthlyIncome,
    incomeEstimate: { basis: streams.length ? 'paycheck-cadence' : incomeMonths ? 'recorded-income-months' : 'insufficient-data', incomeMonths, streams },
    monthlySpend, totalSpend, categories: categories.slice(0, 5), merchants: merchants.slice(0, 5),
    discretionary: { total: extraTotal, annualized: months.length ? round(extraTotal / months.length * 12) : null,
      share: totalSpend ? round(extraTotal / totalSpend * 100) : null, categories: extraCategories.slice(0, 5), merchants: extraMerchants.slice(0, 5) },
    methodology: 'Spending uses up to 12 recorded completed calendar months; imported months may be incomplete. Current recurring income uses the existing pay-cycle detector: the median of the last three pay dates per active source, multiplied by 52 weekly, 26 biweekly, 24 twice-monthly or 12 monthly paychecks. Monthly equivalent is annual income divided by 12, not the amount deposited in every calendar month. If no active schedule is detected, the fallback averages only completed months with recognized income and is not a reliable salary forecast. Income follows your income-review overrides and payroll detection. Recurring estimates exclude undetected sources and assume the current schedule continues; bonuses and future raises are not predicted. Estimates are take-home deposits, not gross salary. Pending entries and classified transfers are excluded. Possible duplicates remain in totals until reviewed. Potentially discretionary means Dining, Shopping, Entertainment, Travel, Recreation or Hobbies, not that every purchase is unnecessary.'
  };
}
