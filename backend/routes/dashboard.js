import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';
import { parseTxDate } from '../utils/normalize.js';
import { buildUpcomingPayments } from '../utils/fixedPayments.js';
import { isIncomeTransaction, projectIncome } from '../utils/income.js';
import { currentUserId } from '../utils/tenant.js';
import { buildPlanPayments, computePlan, loadPlanInputs, typicalSurplus } from '../utils/moneyPlan.js';
import { getEntitlement } from '../utils/license.js';
import { buildAnalytics } from '../utils/analytics.js';
import { buildInsights } from '../utils/insights.js';
import { cashBalance, savedAmount } from '../utils/transfers.js';
import { buildSpendingHistory } from '../utils/spendingHistory.js';
import { recordAudit } from '../utils/audit.js';

const router = Router();
const db = new Database();

// Helper: Get date range based on filter
function getDateRange(filter) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  let startDate, endDate = new Date(today);
  endDate.setHours(23, 59, 59, 999);

  if (filter === 'current') {
    // Current calendar month
    startDate = new Date(today.getFullYear(), today.getMonth(), 1);
    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59);
  } else if (filter === 'last') {
    // Last calendar month
    startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    endDate = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59);
  } else if (filter === 'ytd') {
    // January 1 to today
    startDate = new Date(today.getFullYear(), 0, 1);
    endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
  } else if (filter === 'all') {
    // All time
    startDate = new Date('2000-01-01');
    endDate = new Date('2099-12-31');
  } else {
    // Default to current month
    startDate = new Date(today.getFullYear(), today.getMonth(), 1);
    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59);
  }

  return {
    startDate: `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`,
    endDate: `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`
  };
}

router.post('/summary', async (req, res) => {
  try {
    const { dateFilter = 'current' } = req.body;
    const { startDate, endDate } = getDateRange(dateFilter);

    log('DASHBOARD', `Summary: ${startDate} to ${endDate}`);

    const cash = await loadCash(currentUserId());
    const { balance, balanceSource, balanceCheckedAt, balanceStale } = cash;
    if (balance !== null && !Number.isFinite(balance)) throw new Error('Invalid account balance');

    // 2. Calculation of ACTUAL totals for the selected period (used for charts / AI analysis)
    const result = await db.get(
      `SELECT
        SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) as total_income,
        SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) as total_expenses
      FROM transactions
      WHERE user_id = $1 AND date >= $2 AND date <= $3 AND transfer_kind IS NULL`,
      [currentUserId(), startDate, endDate]
    );

    const periodIncome = parseFloat(result.total_income || 0);
    const periodExpenses = parseFloat(result.total_expenses || 0);

    // 3. The same typical monthly surplus the Goals, Debt and Coach pages use.
    const typical = typicalSurplus(await loadPlanInputs(db, new Date()), new Date());

    res.json({
      income: typical.avgMonthlyIncome ?? 0,
      expenses: typical.avgMonthlyExpenses ?? 0,
      netCashflow: typical.monthlySurplus ?? 0,
      balance: balance,
      balanceSource,
      balanceCheckedAt,
      balanceStale,
      period: { startDate, endDate },
      periodIncome,
      periodExpenses,
      monthsAveraged: typical.monthsUsed,
      historicalNotice: 'Income, spending and surplus are monthly averages of the last 3 full months, transfers excluded.'
    });
  } catch (error) {
    log('DASHBOARD', `Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/monthly-cashflow', async (req, res) => {
  try {
    log('DASHBOARD', 'Fetching monthly cashflow (income vs expense by year)');
    const rows = await db.all(
      `SELECT date, amount, direction, description 
       FROM transactions 
       WHERE user_id = $1 AND transfer_kind IS NULL
       ORDER BY date ASC, id ASC`,
      [currentUserId()]
    );

    const yearData = {};
    const monthsNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    for (const tx of rows) {
      const parsed = parseTxDate(tx.date);
      if (!parsed) continue;

      const y = parsed.year;
      const m = parsed.month; // 0-11
      if (y < 2000 || y > 2100) continue;

      if (!yearData[y]) {
        yearData[y] = Array.from({ length: 12 }, (_, i) => ({
          monthNum: i + 1,
          monthName: monthsNames[i],
          income: 0,
          expenses: 0,
          net: 0,
          txCount: 0
        }));
      }

      const amt = parseFloat(tx.amount) || 0;
      const dir = (tx.direction || '').toUpperCase();
      if (dir === 'CREDIT') {
        yearData[y][m].income += amt;
      } else if (dir === 'DEBIT') {
        yearData[y][m].expenses += amt;
      }
      yearData[y][m].txCount++;
    }

    // Calculate net and annual totals
    const years = Object.keys(yearData).map(Number).sort((a, b) => b - a);
    const summaryByYear = {};

    for (const y of years) {
      let totalIncome = 0;
      let totalExpenses = 0;
      yearData[y].forEach(m => {
        m.income = Math.round(m.income * 100) / 100;
        m.expenses = Math.round(m.expenses * 100) / 100;
        m.net = Math.round((m.income - m.expenses) * 100) / 100;
        totalIncome += m.income;
        totalExpenses += m.expenses;
      });
      summaryByYear[y] = {
        totalIncome: Math.round(totalIncome * 100) / 100,
        totalExpenses: Math.round(totalExpenses * 100) / 100,
        netSavings: Math.round((totalIncome - totalExpenses) * 100) / 100
      };
    }

    const currentYear = new Date().getFullYear();
    if (!years.includes(currentYear)) {
      years.unshift(currentYear);
      yearData[currentYear] = Array.from({ length: 12 }, (_, i) => ({
        monthNum: i + 1,
        monthName: monthsNames[i],
        income: 0,
        expenses: 0,
        net: 0,
        txCount: 0
      }));
      summaryByYear[currentYear] = { totalIncome: 0, totalExpenses: 0, netSavings: 0 };
    }

    res.json({
      success: true,
      years,
      yearData,
      summaryByYear,
      defaultYear: years.includes(currentYear) ? currentYear : years[0]
    });
  } catch (error) {
    log('DASHBOARD', `Error in monthly-cashflow: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

async function loadUpcoming(req, today = new Date()) {
  const previousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const dateString = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const transactions = await db.all(
    `SELECT
      id,
      date,
      description,
      category,
      amount,
      direction,
      label_id,
      account_id,
      is_fixed,
      pay_mode,
      display_name
    FROM transactions
    WHERE user_id = $1 AND date::date >= $2::date AND date::date <= $3::date`,
    [currentUserId(), dateString(previousMonth), dateString(today)]
  );
  const through = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30);
  const bills = buildUpcomingPayments(transactions, today, { through });
  // Income and the flexible debt/goal plan are best-effort: bills still render if planning fails.
  let extras = [], plan = null, pro = false, streams = [];
  try {
    const [inputs, entitlement] = await Promise.all([loadPlanInputs(db, today), getEntitlement(req.user.id)]);
    pro = !!entitlement.plusActive;
    const computed = computePlan(inputs, { pro: !!entitlement.plusActive, now: today });
    plan = entitlement.plusActive ? computed : null;
    streams = computed.income?.streams || [];
    extras = projectIncome(inputs.recent, today, { through }).items;
    if (plan) {
      for (let offset = 0; new Date(today.getFullYear(), today.getMonth() + offset, 1) <= through; offset++) {
        const target = offset === 0 ? today : new Date(today.getFullYear(), today.getMonth() + offset, 1);
        extras.push(...buildPlanPayments(plan, target).map(item => ({
          ...item, date: dateString(new Date(target.getFullYear(), target.getMonth(), item.dayOfMonth)),
          // Future allocations are estimates, not edits to this month's plan.
          flexible: offset === 0 && item.flexible, futurePlan: offset > 0
        })).filter(item => item.date <= dateString(through)));
      }
    }
  } catch (error) {
    log('DASHBOARD', `Upcoming plan items unavailable: ${error.message}`);
  }
  const items = [...bills, ...extras].sort((a, b) => a.date.localeCompare(b.date) || Number(b.isIncome) - Number(a.isIncome));
  return { items, plan, pro, streams };
}

router.post('/upcoming-payments', async (req, res) => {
  try {
    log('DASHBOARD', 'Fetching the next 30 days of payments, overdue bills and current-month history');
    res.json((await loadUpcoming(req)).items);
  } catch (error) {
    log('DASHBOARD', `Error fetching upcoming payments: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Spendable cash plus the account-tracker facts the dashboard highlights. Degrades to the newest balance on failure.
async function loadCash(userId) {
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const rows = await db.all('SELECT id, date, balance, account_id FROM transactions WHERE user_id = $1 AND balance IS NOT NULL', [userId]);
  let accounts = [];
  try { accounts = await db.all('SELECT id, name, kind, last4, status, statement FROM accounts WHERE user_id = $1', [userId]); }
  catch (error) { log('DASHBOARD', `Accounts unavailable: ${error.message}`, 'warn'); }
  const byId = new Map(accounts.map(account => [account.id, account]));
  const statementBalance = cashBalance(rows, byId, todayIso);
  const plaid = await db.get(`SELECT SUM(COALESCE(available_balance,current_balance)) AS balance,
      MAX(balance_checked_at) AS updated_at, COUNT(*) AS account_count
    FROM plaid_accounts WHERE user_id=$1 AND use_for_cashflow=TRUE AND type='depository'
      AND iso_currency_code='USD' AND COALESCE(available_balance,current_balance) IS NOT NULL`,
  [userId]);
  const hasPlaidBalance = Number(plaid.account_count) > 0 && plaid.balance !== null;
  const balanceCheckedAt = hasPlaidBalance ? plaid.updated_at : null;
  return {
    balance: hasPlaidBalance ? Number(plaid.balance) : statementBalance,
    balanceSource: hasPlaidBalance ? 'plaid' : Number.isFinite(statementBalance) ? 'statement' : null,
    balanceCheckedAt,
    balanceStale: balanceCheckedAt ? Date.now() - new Date(balanceCheckedAt).getTime() > 36 * 60 * 60 * 1000 : false,
    accounts,
    byId
  };
}

async function accountSignals(userId, byId, accounts) {
  try {
    const today = new Date();
    const prefix = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const rows = await db.all(`SELECT date, amount, direction, account_id, transfer_kind FROM transactions
      WHERE user_id = $1 AND transfer_kind IN ('savings','unknown')`, [userId]);
    let saved = 0, savedCount = 0, unknownCount = 0, unknownTotal = 0;
    for (const row of rows) {
      if (row.transfer_kind === 'unknown') { unknownCount++; unknownTotal += Math.abs(Number(row.amount)) || 0; continue; }
      if (parseTxDate(row.date)?.iso?.startsWith(prefix)) { saved += savedAmount(row, byId.get(row.account_id)?.kind || null); savedCount++; }
    }
    const review = accounts.filter(account => account.status === 'needs_review');
    return {
      savedThisMonth: { amount: Math.round(saved * 100) / 100, transfers: savedCount },
      unknownTransfers: { count: unknownCount, total: Math.round(unknownTotal * 100) / 100 },
      accountsToReview: review.map(account => ({ id: account.id, name: account.name, last4: account.last4 }))
    };
  } catch (error) {
    log('DASHBOARD', `Account signals unavailable: ${error.message}`, 'warn');
    return null;
  }
}

// Import freshness is a nice-to-have: any failure degrades to "unknown" instead of breaking the dashboard.
async function importStats(userId) {
  try {
    const row = await db.get('SELECT COUNT(*) AS total, MAX(created_at) AS last_import FROM transactions WHERE user_id = $1', [userId]);
    const dates = await db.all('SELECT DISTINCT date FROM transactions WHERE user_id = $1', [userId]);
    const latestDate = dates.map(r => parseTxDate(r.date)?.iso).filter(Boolean).sort().pop() || null;
    const at = row?.last_import ? new Date(row.last_import) : null;
    return { total: Number(row?.total) || 0, lastImportAt: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null, latestDate };
  } catch (error) {
    log('DASHBOARD', `Import freshness unavailable: ${error.message}`, 'warn');
    const row = await db.get('SELECT COUNT(*) AS total FROM transactions WHERE user_id = $1', [userId]);
    return { total: Number(row?.total) || 0, lastImportAt: null, latestDate: null };
  }
}

router.get('/insights', async (req, res) => {
  try {
    const today = new Date();
    const userId = currentUserId();
    const [{ items, plan, pro, streams }, cash, count] = await Promise.all([
      loadUpcoming(req, today),
      // Text dates are parsed in JS so one malformed row cannot fail the whole dashboard.
      loadCash(userId).catch(error => { log('DASHBOARD', `Latest balance unavailable: ${error.message}`, 'warn'); return { balance: null, accounts: [], byId: new Map() }; }),
      importStats(userId)
    ]);
    const balance = cash.balance;
    const accounts = count.total > 0 ? await accountSignals(userId, cash.byId, cash.accounts) : null;
    let analytics = null;
    if (pro) {
      try {
        analytics = await db.transaction(async client => {
          const transactions = (await client.query('SELECT id, date, description, amount, direction, category, is_fixed, label_id, transfer_kind, display_name FROM transactions ORDER BY date, id')).rows;
          const budgets = (await client.query('SELECT category, monthly_amount FROM category_budgets')).rows
            .map(row => ({ category: row.category, amount: Number(row.monthly_amount) }));
          return buildAnalytics({ transactions, budgets, latestBalance: balance, today });
        });
      } catch (error) {
        log('DASHBOARD', `Insight analytics unavailable: ${error.message}`);
      }
    }
    // Rows imported before created_at existed have no import time; the newest transaction date is the best proxy.
    const importedAt = count.lastImportAt || (count.latestDate ? `${count.latestDate}T12:00:00.000Z` : null);
    const lastImport = importedAt ? { at: importedAt, latestDate: count.latestDate } : null;
    res.json(buildInsights({ today, balance, upcoming: items, plan, analytics, pro, hasData: count.total > 0, incomeStreams: streams, lastImport, accounts }));
  } catch (error) {
    log('DASHBOARD', `Error building insights: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/spending-history', async (req, res, next) => {
  try {
    const entitlement = await getEntitlement(currentUserId());
    const inputs = await db.transaction(async client => {
      const transactions = (await client.query('SELECT date,amount,direction,category,transfer_kind FROM transactions WHERE user_id=$1', [currentUserId()])).rows;
      const budgets = entitlement.plusActive
        ? (await client.query('SELECT category,monthly_amount FROM category_budgets WHERE user_id=$1', [currentUserId()])).rows.map(row => ({ category: row.category, amount: Number(row.monthly_amount) }))
        : [];
      return { transactions, budgets };
    });
    res.json(buildSpendingHistory({ ...inputs, pro: entitlement.plusActive }));
  } catch (error) { next(error); }
});

router.post('/category-spending', async (req, res) => {
  try {
    const { dateFilter = 'current' } = req.body;
    const { startDate, endDate } = getDateRange(dateFilter);

    log('DASHBOARD', `Category spending: ${startDate} to ${endDate}`);

    const result = await db.all(
      `SELECT 
        category,
        SUM(CASE WHEN UPPER(direction) = 'DEBIT' THEN amount ELSE 0 END) as total_spending,
        COUNT(*) as transaction_count,
        DATE_TRUNC('month', date::date)::date as month
      FROM transactions
      WHERE user_id = $1 AND date >= $2 AND date <= $3 AND UPPER(direction) = 'DEBIT' AND transfer_kind IS NULL
      GROUP BY category, DATE_TRUNC('month', date::date)
      ORDER BY month DESC, total_spending DESC`,
      [currentUserId(), startDate, endDate]
    );

    // Format response
    const categoryByMonth = {};
    result.forEach(row => {
      const cat = row.category || 'Other';
      if (!categoryByMonth[cat]) {
        categoryByMonth[cat] = [];
      }
      categoryByMonth[cat].push({
        month: row.month,
        spending: parseFloat(row.total_spending),
        transactions: parseInt(row.transaction_count)
      });
    });

    // Convert to flat list with totals
    const categories = Object.entries(categoryByMonth).map(([name, months]) => ({
      name,
      totalSpending: months.reduce((sum, m) => sum + m.spending, 0),
      transactionCount: months.reduce((sum, m) => sum + m.transactions, 0),
      monthlyBreakdown: months
    })).sort((a, b) => b.totalSpending - a.totalSpending);

    res.json(categories);
  } catch (error) {
    log('DASHBOARD', `Error fetching category spending: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/category-transactions', async (req, res) => {
  try {
    const { category, month } = req.body;

    if (!category || !month) {
      return res.status(400).json({ error: 'category and month are required' });
    }

    log('DASHBOARD', `Fetching transactions for category: ${category}, month: ${month}`);

    // Parse month (format: YYYY-MM-DD or similar)
    const monthStart = new Date(month);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    
    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    monthEnd.setDate(0);
    monthEnd.setHours(23, 59, 59, 999);

    const startDate = monthStart.toISOString().split('T')[0];
    const endDate = monthEnd.toISOString().split('T')[0];

    const result = await db.all(
      `SELECT 
        date,
        COALESCE(display_name, description) AS description,
        amount
      FROM transactions
      WHERE user_id = $1 AND category = $2 AND date >= $3 AND date <= $4
      ORDER BY date DESC`,
      [currentUserId(), category, startDate, endDate]
    );

    const transactions = result.map(row => ({
      date: row.date,
      description: row.description,
      amount: parseFloat(row.amount)
    }));

    log('DASHBOARD', `Found ${transactions.length} transactions for category ${category}`);
    res.json(transactions);
  } catch (error) {
    log('DASHBOARD', `Error fetching category transactions: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/category-trends', async (req, res) => {
  try {
    log('DASHBOARD', 'Fetching category trends (month-over-month)');

    const result = await db.all(
      `SELECT 
        category,
        DATE_TRUNC('month', date::date)::date as month,
        SUM(CASE WHEN UPPER(direction) = 'DEBIT' THEN amount ELSE 0 END) as total_spending,
        COUNT(*) as transaction_count
      FROM transactions
      WHERE user_id = $1 AND UPPER(direction) = 'DEBIT' AND transfer_kind IS NULL
      GROUP BY category, DATE_TRUNC('month', date::date)
      ORDER BY month DESC, category ASC`,
      [currentUserId()]
    );

    // Organize by month, then category
    const trendsByMonth = {};
    result.forEach(row => {
      const month = row.month;
      if (!trendsByMonth[month]) {
        trendsByMonth[month] = [];
      }
      trendsByMonth[month].push({
        category: row.category || 'Other',
        spending: parseFloat(row.total_spending),
        transactions: parseInt(row.transaction_count)
      });
    });

    res.json(trendsByMonth);
  } catch (error) {
    log('DASHBOARD', `Error fetching category trends: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/category-transactions-for-month', async (req, res) => {
  try {
    const { category, month } = req.body;

    if (!category || !month) {
      return res.status(400).json({ error: 'category and month are required' });
    }

    log('DASHBOARD', `Fetching transactions for category: ${category}, month: ${month}`);

    // Parse month (format: YYYY-MM or similar)
    let monthStart, monthEnd;
    
    // Handle both "2026-05" and "2026-05-01" formats
    if (month.length === 7) {
      // "2026-05" format
      const [year, monthNum] = month.split('-');
      monthStart = new Date(parseInt(year), parseInt(monthNum) - 1, 1);
    } else {
      // "2026-05-01" format
      monthStart = new Date(month);
    }
    
    monthStart.setHours(0, 0, 0, 0);
    
    monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    monthEnd.setDate(0);
    monthEnd.setHours(23, 59, 59, 999);

    const startDate = monthStart.toISOString().split('T')[0];
    const endDate = monthEnd.toISOString().split('T')[0];

    const result = await db.all(
      `SELECT 
        id,
        date,
        COALESCE(display_name, description) AS description,
        amount,
        category as currentCategory
      FROM transactions
      WHERE user_id = $1 AND category = $2 AND date >= $3 AND date <= $4 AND UPPER(direction) = 'DEBIT'
      ORDER BY date DESC`,
      [currentUserId(), category, startDate, endDate]
    );

    const transactions = result.map(row => ({
      id: row.id,
      date: row.date,
      description: row.description,
      amount: parseFloat(row.amount),
      currentCategory: row.currentCategory
    }));

    log('DASHBOARD', `Found ${transactions.length} transactions for category ${category} in ${month}`);
    res.json(transactions);
  } catch (error) {
    log('DASHBOARD', `Error fetching category transactions for month: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// GET ALL TRANSACTIONS (for filtering by category)
router.get('/all-transactions', async (req, res) => {
  try {
    const result = await db.all(`
      SELECT 
        t.id,
        t.date,
        t.description,
        t.display_name,
        t.amount,
        t.direction,
        t.category,
        t.is_fixed,
        t.pay_mode,
        t.income_role,
        t.user_id,
        t.transfer_kind,
        t.account_id,
        a.name AS account_name,
        a.kind AS account_kind,
        a.last4 AS account_last4,
        o.name AS transfer_account_name
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id AND a.user_id = t.user_id
      LEFT JOIN accounts o ON o.id = t.transfer_account_id AND o.user_id = t.user_id
      WHERE t.user_id = $1
      ORDER BY t.date DESC
    `, [currentUserId()]);

    log('DASHBOARD', `Returning ${result.length} total transactions (including is_fixed)`);

    res.json({
      total: result.length,
      transactions: result.map(row => ({
        ...row,
        id: row.id.toString(),
        amount: parseFloat(row.amount),
        is_fixed: row.is_fixed === true || row.is_fixed === 1 || row.is_fixed === 'true',
        counts_as_income: row.transfer_kind == null && isIncomeTransaction(row)
      }))
    });
  } catch (error) {
    log('DASHBOARD', `Error fetching all transactions: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// UPDATE TRANSACTION CATEGORY
router.post('/update-category', async (req, res) => {
  try {
    const { transaction_id, new_category } = req.body;

    if (!transaction_id || !new_category) {
      log('CATEGORIZE', `❌ Missing required fields: transaction_id=${transaction_id}, new_category=${new_category}`);
      return res.status(400).json({ error: 'Missing transaction_id or new_category' });
    }

    // Get old category before update
    const oldTxn = await db.get('SELECT id, date, description, category FROM transactions WHERE id = $1 AND user_id = $2', [transaction_id, currentUserId()]);
    
    if (!oldTxn) {
      log('CATEGORIZE', `❌ Transaction not found: ID ${transaction_id}`);
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const oldCategory = oldTxn.category || 'Uncategorized';

    // Update the transaction
    const validCategory = await db.get('SELECT id FROM categories WHERE name = $1', [new_category]);
    if (!validCategory) return res.status(400).json({ error: 'Choose one of your categories' });
    await db.run('UPDATE transactions SET category = $1, previous_category = category, category_corrected = TRUE, correction_timestamp = NOW() WHERE id = $2 AND user_id = $3', [new_category, transaction_id, currentUserId()]);
    await recordAudit(req, 'transaction.reclassified', 'success', {
      detail: { transactionId: Number(transaction_id), date: oldTxn.date, previousCategory: oldCategory, category: new_category }
    });

    log('CATEGORIZE', `✅ Updated transaction ${transaction_id}: ${oldCategory} → ${new_category}`);

    res.json({
      success: true,
      message: `Updated category from "${oldCategory}" to "${new_category}"`,
      transaction: {
        id: transaction_id,
        description: oldTxn.description,
        old_category: oldCategory,
        new_category: new_category
      }
    });
  } catch (error) {
    log('CATEGORIZE', `❌ Error updating category: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// TEST ENDPOINT: Get all transactions with categories
router.get('/transactions/test', async (req, res) => {
  try {
    const result = await db.all(`
      SELECT 
        id,
        date,
        description,
        amount,
        direction,
        category,
        user_id
      FROM transactions
      WHERE user_id = $1
      ORDER BY date DESC
    `, [currentUserId()]);

    res.json({
      total: result.length,
      transactions: result.map(row => ({
        id: row.id,
        date: row.date,
        description: row.description,
        amount: parseFloat(row.amount),
        direction: row.direction,
        category: row.category || 'Uncategorized'
      }))
    });
  } catch (error) {
    log('DASHBOARD', `Error in test endpoint: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
