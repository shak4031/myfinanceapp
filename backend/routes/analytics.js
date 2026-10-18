import { Router } from 'express';
import Database from '../db.js';
import { requirePro } from '../utils/license.js';
import { buildAnalytics, toCsv } from '../utils/analytics.js';
import { parseTxDate } from '../utils/normalize.js';
import { loadPlanInputs, typicalSurplus } from '../utils/moneyPlan.js';
import { cashBalance } from '../utils/transfers.js';
import { currentUserId } from '../utils/tenant.js';

const router = Router();
const db = new Database();

router.use(requirePro);

async function loadInputs() {
  return db.transaction(async client => {
    const transactions = (await client.query(
      'SELECT id, date, description, amount, direction, category, is_fixed, label_id, transfer_kind FROM transactions ORDER BY date, id')).rows;
    const budgets = (await client.query('SELECT category, monthly_amount FROM category_budgets')).rows
      .map(row => ({ category: row.category, amount: Number(row.monthly_amount) }));
    // Starting cash is checking accounts only, matching the dashboard.
    const balances = (await client.query('SELECT id, date, balance, account_id FROM transactions WHERE balance IS NOT NULL')).rows;
    const accounts = (await client.query('SELECT id, kind FROM accounts WHERE user_id = $1', [currentUserId()])).rows;
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return { transactions, budgets, latestBalance: cashBalance(balances, new Map(accounts.map(account => [account.id, account])), todayIso) };
  });
}

router.get('/', async (req, res, next) => {
  try {
    const now = new Date();
    const [inputs, planInputs] = await Promise.all([loadInputs(), loadPlanInputs(db, now)]);
    res.json(buildAnalytics({ ...inputs, typical: typicalSurplus(planInputs, now) }));
  } catch (error) { next(error); }
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/export.csv', async (req, res, next) => {
  try {
    const type = req.query.type === 'categories' ? 'categories' : 'transactions';
    const from = ISO_DATE.test(req.query.from || '') ? req.query.from : null;
    const to = ISO_DATE.test(req.query.to || '') ? req.query.to : null;
    const inputs = await loadInputs();
    let csv;
    if (type === 'categories') {
      const { categories, months } = buildAnalytics(inputs);
      csv = toCsv(categories, [
        { label: 'Category', value: c => c.name },
        { label: 'Month to date', value: c => c.mtd },
        { label: 'Same point last month', value: c => c.lastMonthToDate },
        { label: 'Change', value: c => c.deltaMtd },
        { label: 'Last month', value: c => c.lastMonth },
        { label: '3-month average', value: c => c.sma3 },
        { label: '6-month average', value: c => c.sma6 },
        { label: 'Projected month', value: c => c.projected },
        { label: 'Share of spend', value: c => c.share },
        { label: 'Trend per month', value: c => c.trend },
        { label: 'Budget', value: c => c.budget },
        ...months.map((month, index) => ({ label: month, value: c => c.series[index] }))
      ]);
    } else {
      const rows = inputs.transactions.map(tx => ({ ...tx, iso: parseTxDate(tx.date)?.iso || String(tx.date) }))
        .filter(tx => (!from || tx.iso >= from) && (!to || tx.iso <= to))
        .sort((a, b) => b.iso.localeCompare(a.iso));
      csv = toCsv(rows, [
        { label: 'Date', value: tx => tx.iso },
        { label: 'Description', value: tx => tx.description },
        { label: 'Category', value: tx => tx.category || 'Other' },
        { label: 'Direction', value: tx => tx.direction },
        { label: 'Amount', value: tx => Number(tx.amount).toFixed(2) },
        { label: 'Fixed bill', value: tx => (tx.is_fixed ? 'yes' : 'no') },
        { label: 'Transfer (not counted)', value: tx => tx.transfer_kind || '' }
      ]);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="myfinance-${type}-${stamp}.csv"`);
    res.send(csv);
  } catch (error) { next(error); }
});

export default router;
