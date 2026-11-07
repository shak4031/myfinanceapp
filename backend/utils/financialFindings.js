import { parseTxDate } from './normalize.js';
import { isTransferRow } from './transfers.js';
import { isIncomeTransaction } from './income.js';
import { merchantGroup, merchantLabel } from './analytics.js';

const discretionary = /^(dining|dining out|eating out|restaurants?|shopping|entertainment|travel|recreation|hobbies)$/i;
const uncategorized = /^(other|uncategorized|uncategorised)$/i;
const round = value => Math.round(value * 100) / 100;
const money = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
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

export function buildFinancialFindings({ transactions = [], budgets = [], connections = [], duplicateCount = 0, today = new Date() } = {}) {
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
  const monthlyIncome = months.length && income.length ? round(totalIncome / months.length) : null;
  const monthlySpend = months.length ? round(totalSpend / months.length) : null;
  const categories = groupTotals(spend, row => row.category);
  const merchants = groupTotals(spend, merchantGroup, merchantLabel);
  const extras = spend.filter(row => discretionary.test(row.category));
  const extraTotal = round(extras.reduce((sum, row) => sum + row.amount, 0));
  const extraCategories = groupTotals(extras, row => row.category);
  const extraMerchants = groupTotals(extras, merchantGroup, merchantLabel);
  const currentSpend = rows.filter(row => row.month === current && row.direction === 'DEBIT');
  const other = currentSpend.filter(row => uncategorized.test(row.category));
  const configured = new Set(budgets.filter(row => Number(row.monthly_amount ?? row.amount) > 0).map(row => row.category));
  const unbudgeted = groupTotals(currentSpend, row => row.category).filter(row => !configured.has(row.name) && !uncategorized.test(row.name));
  const latest = rows.map(row => row.iso).sort().at(-1) || null;
  const signals = [];
  const add = (id, title, detail, route, action = null) => signals.push({ id, title, detail, route, action });
  if (duplicateCount > 0) add('duplicates', `${duplicateCount} possible duplicate matches need review`,
    'Saved bank-connected records may overlap with uploaded or manual entries. Compare accounts, dates and descriptions before merging; matches are not proof of duplicates.', 'transactions', 'duplicates');
  for (const connection of connections) {
    const at = connection.last_sync_at ? new Date(connection.last_sync_at) : null;
    const age = at && Number.isFinite(at.getTime()) ? Math.max(0, Math.floor((today - at) / 86400000)) : null;
    if (connection.status !== 'active' || age === null || age >= 3) {
      add(`sync-${connection.id}`, `${connection.institution_name || 'Bank connection'} needs a sync check`,
        `${age === null ? 'No successful sync is recorded.' : `The last successful sync was ${age} days ago.`} ${connection.status !== 'active' ? 'The connection is not active. ' : ''}Review its status and reconnect or sync from Accounts.`, 'accounts');
    }
  }
  if (!connections.length) add('import', 'Keep your transaction history current',
    `${latest ? `Your latest recorded transaction is dated ${latest}. ` : 'No transaction history is available yet. '}No bank connection is configured. Import your latest statements from Transactions.`, 'transactions', 'import');
  if (other.length) add('uncategorized', `${other.length} transactions are in Other this month`,
    `${money(other.reduce((sum, row) => sum + row.amount, 0))} of spending has no specific category. Review these entries so spending summaries and budgets are meaningful.`, 'transactions', 'other');
  if (monthlyIncome !== null && monthlySpend > monthlyIncome) add('deficit', 'Recorded spending exceeds recognized income',
    `Across ${months.length} recorded completed months, spending averages ${money(monthlySpend)} against ${money(monthlyIncome)} of recognized monthly income: a ${money(monthlySpend - monthlyIncome)} monthly gap. Review flexible spending before adding commitments.`, 'insights');
  if (extraTotal > 0) add('extras', `${money(extraTotal)} in potentially discretionary spending`,
    `In ${months.length} recorded completed months, ${extraCategories.slice(0, 3).map(row => `${row.name}: ${money(row.amount)}`).join('; ')}. ${totalSpend ? Math.round(extraTotal / totalSpend * 100) : 0}% of recorded spending falls in these categories. Decide which purchases can be reduced; category labels alone do not prove a purchase was unnecessary.`, 'insights');
  for (const category of unbudgeted.slice(0, 3)) add(`budget-${category.name}`, `No budget for ${category.name}`,
    `You have spent ${money(category.amount)} in this category this month. Set a monthly limit in Categories; budget editing requires Pro.`, 'categories');
  const large = currentSpend.filter(row => !String(row.note || '').trim()).sort((a, b) => b.amount - a.amount)
    .find(row => row.amount >= Math.max(1000, monthlySpend === null ? 1000 : monthlySpend * 0.2));
  if (large) add('large', `Add context for ${money(large.amount)} at ${merchantLabel(large)}`,
    `Transaction #${large.id} on ${large.iso} has no note. Add a note from the transaction's note control so you can explain this purchase later.`, 'transactions', `note:${large.id}`);
  return {
    period: { from: months.length ? monthKey(months[0]) : null, to: months.length ? monthKey(months.at(-1)) : null, months: months.length },
    monthlyIncome, annualIncome: monthlyIncome === null ? null : round(monthlyIncome * 12),
    monthlySpend, totalSpend, categories: categories.slice(0, 5), merchants: merchants.slice(0, 5),
    discretionary: { total: extraTotal, annualized: months.length ? round(extraTotal / months.length * 12) : null,
      share: totalSpend ? round(extraTotal / totalSpend * 100) : null, categories: extraCategories.slice(0, 5), merchants: extraMerchants.slice(0, 5) },
    methodology: 'Uses up to 12 recorded completed calendar months. Missing months are excluded, not treated as zero; imported months may be incomplete. Income follows your income-review overrides and payroll detection. Annualized income is recognized take-home deposits, not gross salary. Pending entries and classified transfers are excluded. Possible duplicates remain in totals until reviewed. Potentially discretionary means Dining, Shopping, Entertainment, Travel, Recreation or Hobbies, not that every purchase is unnecessary.',
    signals
  };
}
