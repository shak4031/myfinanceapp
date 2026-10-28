import { Router } from 'express';
import Database from '../db.js';
import { requirePro } from '../utils/license.js';
import { buildAnalytics, toCsv } from '../utils/analytics.js';
import { buildMoneyFlowSignals, normalizeProfile, REGIONS, HOUSING, MAX_HOUSEHOLD } from '../utils/benchmarks.js';
import { parseTxDate } from '../utils/normalize.js';
import { loadPlanInputs, typicalSurplus } from '../utils/moneyPlan.js';
import { cashBalance } from '../utils/transfers.js';
import { currentUserId } from '../utils/tenant.js';
import { performance } from 'node:perf_hooks';

const router = Router();
const db = new Database();

router.use(requirePro);

async function timed(res, name, callback) {
  const started = performance.now();
  try { return await callback(); }
  finally { res.append('Server-Timing', `${name};dur=${(performance.now() - started).toFixed(2)}`); }
}

async function loadInputs() {
  return db.transaction(async client => {
    const transactions = (await client.query(
      'SELECT id, date, description, amount, direction, category, is_fixed, label_id, transfer_kind, display_name, account_id, pay_mode FROM transactions ORDER BY date, id')).rows;
    const budgets = (await client.query('SELECT category, monthly_amount FROM category_budgets')).rows
      .map(row => ({ category: row.category, amount: Number(row.monthly_amount) }));
    // Starting cash is checking accounts only, matching the dashboard.
    const balances = (await client.query('SELECT id, date, balance, account_id FROM transactions WHERE balance IS NOT NULL')).rows;
    const accounts = (await client.query('SELECT id, kind, statement FROM accounts WHERE user_id = $1', [currentUserId()])).rows;
    const household = (await client.query('SELECT household_size AS size, region, housing FROM household_profiles LIMIT 1')).rows[0] || null;
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return { transactions, budgets, household, latestBalance: cashBalance(balances, new Map(accounts.map(account => [account.id, account])), todayIso) };
  });
}

router.get('/', async (req, res, next) => {
  try {
    const now = new Date();
    const [inputs, planInputs] = await Promise.all([
      timed(res, 'inputs', loadInputs), timed(res, 'plan', () => loadPlanInputs(db, now))
    ]);
    const typical = typicalSurplus(planInputs, now);
    const analytics = await timed(res, 'analytics', () => buildAnalytics({ ...inputs, typical }));
    const end = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const start = new Date(end.getFullYear(), end.getMonth() - 2, 1);
    const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const range = { from: key(start), to: key(end), months: 3, endYear: end.getFullYear(), endMonth: end.getMonth() };
    const moneyFlow = await timed(res, 'compass', () => buildMoneyFlowSignals({ transactions: inputs.transactions, profile: inputs.household, today: now, typical, range }));
    moneyFlow.range = range;
    res.json({
      ...analytics, moneyFlow
    });

  } catch (error) { next(error); }
});

router.get('/compass', async (req, res, next) => {
  try {
    const now = new Date();
    const monthIndex = value => {
      if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
      return Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
    };
    const from = monthIndex(req.query.from), to = monthIndex(req.query.to);
    if (from === null || to === null || from > to || to - from >= 24 || from < 1900 * 12
      || to >= now.getFullYear() * 12 + now.getMonth()) {
      return res.status(400).json({ error: 'Choose 1–24 completed calendar months, with a valid start and end (YYYY-MM).' });
    }
    const inputs = await timed(res, 'inputs', loadInputs);
    const range = { from: req.query.from, to: req.query.to, months: to - from + 1, endYear: Math.floor(to / 12), endMonth: to % 12 };
    const latestCompleted = now.getFullYear() * 12 + now.getMonth() - 1;
    const typical = range.months === 3 && to === latestCompleted
      ? typicalSurplus(await timed(res, 'plan', () => loadPlanInputs(db, now)), now) : null;
    const moneyFlow = await timed(res, 'compass', () => buildMoneyFlowSignals({ transactions: inputs.transactions, profile: inputs.household, today: now, typical, range }));
    res.json({ ...moneyFlow, range });
  } catch (error) { next(error); }
});

// Household details choose which public benchmark applies. Every field is optional; null clears it.
router.put('/household', async (req, res, next) => {
  try {
    const body = req.body || {};
    const fields = { size: body.size ?? null, region: body.region ?? null, housing: body.housing ?? null };
    const profile = normalizeProfile(fields);
    if ((fields.size !== null && profile.size === null) || (fields.region !== null && profile.region === null)
      || (fields.housing !== null && profile.housing === null)) {
      return res.status(400).json({ error: `size must be 1-${MAX_HOUSEHOLD}, region one of ${REGIONS.join('/')}, housing one of ${HOUSING.join('/')} (or null)` });
    }
    await db.run(`INSERT INTO household_profiles (household_size, region, housing, updated_at) VALUES ($1,$2,$3,NOW())
      ON CONFLICT (user_id) DO UPDATE SET household_size=EXCLUDED.household_size, region=EXCLUDED.region, housing=EXCLUDED.housing, updated_at=NOW()`,
    [profile.size, profile.region, profile.housing]);
    res.json({ household: profile });
  } catch (error) { next(error); }
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/export.csv', async (req, res, next) => {
  try {
    const type = req.query.type === 'categories' ? 'categories' : 'transactions';
    const from = ISO_DATE.test(req.query.from || '') ? req.query.from : null;
    const to = ISO_DATE.test(req.query.to || '') ? req.query.to : null;
    const transactionId = req.query.transactionId;
    if (transactionId !== undefined && (typeof transactionId !== 'string' || !/^[1-9]\d*$/.test(transactionId) || !Number.isSafeInteger(Number(transactionId)))) {
      return res.status(400).json({ error: 'Transaction ID must be a positive whole number.' });
    }
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
        .filter(tx => !transactionId || String(tx.id) === transactionId)
        .sort((a, b) => b.iso.localeCompare(a.iso));
      csv = toCsv(rows, [
        { label: 'Date', value: tx => tx.iso },
        { label: 'Description', value: tx => tx.description },
        { label: 'Payee', value: tx => tx.display_name || tx.description },
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
