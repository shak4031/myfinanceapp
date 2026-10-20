import { parseTxDate } from './normalize.js';
import { isTransferRow } from './transfers.js';

const round = value => Math.round(value * 100) / 100;
const key = index => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;

export function buildSpendingHistory({ transactions, budgets = [], pro = false, today = new Date() }) {
  const current = today.getFullYear() * 12 + today.getMonth();
  const months = Array.from({ length: 6 }, (_, i) => key(current - 6 + i));
  const asOf = `${key(current)}-${String(today.getDate()).padStart(2, '0')}`;
  const rows = transactions.flatMap(row => {
    const date = parseTxDate(row.date);
    const amount = Math.abs(Number(row.amount));
    if (!date || date.iso > asOf || !Number.isFinite(amount) || !amount || isTransferRow(row)) return [];
    return [{ ...row, amount, month: date.year * 12 + date.month }];
  });
  const first = rows.reduce((earliest, row) => Math.min(earliest, row.month), current);
  const totals = new Map();
  for (const row of rows) {
    if (String(row.direction).toUpperCase() !== 'DEBIT' || row.month < current - 6 || row.month >= current) continue;
    const signature = JSON.stringify([row.category || 'Other', row.month]);
    const point = totals.get(signature) || { amount: 0, transactions: 0 };
    point.amount += row.amount;
    point.transactions++;
    totals.set(signature, point);
  }
  const names = new Set(rows.filter(row => String(row.direction).toUpperCase() === 'DEBIT' && row.month >= current - 6)
    .map(row => row.category || 'Other'));
  const budgetMap = new Map(budgets.filter(b => Number(b.amount) > 0).map(b => [b.category, Number(b.amount)]));
  if (pro) for (const name of budgetMap.keys()) names.add(name);
  const categories = [...names].sort().map(name => {
    const series = months.map((month, index) => ({ month, amount: current - 6 + index < first ? null : 0, transactions: 0 }));
    for (let index = 0; index < 6; index++) {
      const total = totals.get(JSON.stringify([name, current - 6 + index]));
      if (total) Object.assign(series[index], total);
    }
    for (const point of series) if (point.amount != null) point.amount = round(point.amount);
    const observed = series.filter(point => point.amount != null);
    const average = observed.length ? round(observed.reduce((sum, point) => sum + point.amount, 0) / observed.length) : null;
    const sorted = [...observed].sort((a, b) => a.amount - b.amount);
    const budget = budgetMap.get(name) ?? null;
    const previous = series.at(-2)?.amount, latest = series.at(-1)?.amount;
    return {
      name, series, average, observedMonths: observed.length,
      stats: pro ? {
        highest: sorted.length ? { month: sorted.at(-1).month, amount: sorted.at(-1).amount } : null,
        lowest: sorted.length ? { month: sorted[0].month, amount: sorted[0].amount } : null,
        changePct: previous > 0 && latest != null ? round((latest - previous) / previous * 100) : null,
        transactionCount: observed.reduce((sum, point) => sum + point.transactions, 0),
        budget, monthsOverBudget: budget == null ? null : observed.filter(point => point.amount > budget).length,
        budgetComparison: budget == null ? null : 'current-budget'
      } : null
    };
  });
  return { asOf, pro, months, categories };
}
