import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';
import { parseTxDate } from '../utils/normalize.js';
import { buildUpcomingPayments } from '../utils/fixedPayments.js';
import { currentUserId } from '../utils/tenant.js';
import { buildPlanPayments, computePlan, loadPlanInputs, typicalSurplus } from '../utils/moneyPlan.js';
import { getEntitlement } from '../utils/license.js';
import { buildAnalytics } from '../utils/analytics.js';
import { buildInsights } from '../utils/insights.js';
import { isIncomeTransaction } from '../utils/income.js';

const router = Router();
const db = new Database();

// Helper: Internal transfer keywords to exclude
const INTERNAL_TRANSFER_KEYWORDS = ['transfer', 'xfer', 'move', 'internal', 'savings', 'chequing', 'acct'];

// Helper: Check if transaction is an internal transfer
function isInternalTransfer(description) {
  if (!description) return false;
  const desc = description.toLowerCase();
  return INTERNAL_TRANSFER_KEYWORDS.some(keyword => desc.includes(keyword));
}

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

// Helper: Calculate 3-month historical averages (excluding internal transfers)
async function getHistoricalAverages() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Get last 3 months (April, May, June for June 4)
    const threeMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 2, 1);
    const startDate = threeMonthsAgo.toISOString().split('T')[0];
    const endDate = today.toISOString().split('T')[0];
    
    log('DASHBOARD', `Calculating historical averages from ${startDate} to ${endDate}`);
    
    const result = await db.all(
      `SELECT 
        DATE_TRUNC('month', date::date)::date as month,
        SUM(CASE WHEN UPPER(COALESCE(direction, '')) = 'CREDIT' THEN COALESCE(amount, 0) ELSE 0 END) as monthly_income,
        SUM(CASE WHEN UPPER(COALESCE(direction, '')) = 'DEBIT' THEN COALESCE(amount, 0) ELSE 0 END) as monthly_expenses
      FROM transactions
      WHERE user_id = $1 AND date >= $2 AND date <= $3
      GROUP BY DATE_TRUNC('month', date::date)
      ORDER BY month DESC`,
      [currentUserId(), startDate, endDate]
    );
    
    log('DASHBOARD', `Historical query returned ${result.length} months: ${JSON.stringify(result)}`);
    
    if (result.length === 0) {
      log('DASHBOARD', 'No transactions found in historical period');
      return { avgIncome: 0, avgExpenses: 0, months: [] };
    }
    
    // Filter out internal transfers from averages
    let totalIncome = 0;
    let totalExpenses = 0;
    const filteredMonths = [];
    
    for (const month of result) {
      const monthTransactions = await db.all(
        `SELECT description, amount, direction FROM transactions 
         WHERE user_id = $1 AND DATE_TRUNC('month', date::date)::date = $2`,
        [currentUserId(), month.month]
      );
      
      let monthIncome = 0;
      let monthExpenses = 0;
      
      for (const tx of monthTransactions) {
        if (isInternalTransfer(tx.description)) {
          continue; // Skip internal transfers
        }
        
        if (tx.direction && tx.direction.toUpperCase() === 'CREDIT') {
          monthIncome += parseFloat(tx.amount) || 0;
        } else if (tx.direction && tx.direction.toUpperCase() === 'DEBIT') {
          monthExpenses += parseFloat(tx.amount) || 0;
        }
      }
      
      totalIncome += monthIncome;
      totalExpenses += monthExpenses;
      filteredMonths.push({
        month: month.month,
        monthly_income: monthIncome,
        monthly_expenses: monthExpenses
      });
    }
    
    const avgIncome = filteredMonths.length > 0 ? totalIncome / filteredMonths.length : 0;
    const avgExpenses = filteredMonths.length > 0 ? totalExpenses / filteredMonths.length : 0;
    
    log('DASHBOARD', `Historical averages (filtered): Income $${avgIncome.toFixed(2)}, Expenses $${avgExpenses.toFixed(2)}`);
    
    return { avgIncome, avgExpenses, months: filteredMonths };
  } catch (error) {
    log('DASHBOARD', `Error calculating historical averages: ${error.message}`);
    return { avgIncome: 0, avgExpenses: 0, months: [] };
  }
}

// Helper: Detect recurring payments (subscriptions, bills) - excluding internal transfers
async function getRecurringPayments() {
  try {
    const result = await db.all(
      `SELECT 
        description,
        category,
        amount,
        EXTRACT(DAY FROM date::date) as day_of_month,
        MAX(is_fixed::int)::boolean as is_fixed_flag,
        COUNT(*) as frequency,
        MAX(date) as last_date
      FROM transactions
      WHERE user_id = $1 AND (UPPER(direction) = 'DEBIT' OR is_fixed = TRUE)
      GROUP BY description, category, amount, EXTRACT(DAY FROM date::date)
      HAVING COUNT(*) >= 2 OR MAX(is_fixed::int) = 1
      ORDER BY frequency DESC, last_date DESC`,
      [currentUserId()]
    );
    
    return result.filter(p => {
      // Exclude internal transfers
      if (isInternalTransfer(p.description)) {
        return false;
      }
      const recurring = p.frequency >= 2;
      const isSubscription = /netflix|prime|spotify|hulu|subscription|monthly|fee|bill|payment|insurance|mortgage|utilities/i.test(p.description);
      const isFixedManual = p.is_fixed_flag === true;
      return recurring || isSubscription || isFixedManual;
    }).map(p => ({
      description: p.description,
      amount: parseFloat(p.amount),
      dayOfMonth: parseInt(p.day_of_month),
      lastDate: p.last_date,
      frequency: parseInt(p.frequency)
    }));
  } catch (error) {
    log('DASHBOARD', `Error detecting recurring payments: ${error.message}`);
    return [];
  }
}

// Helper: Categorize subscriptions
function categorizeSubscription(description) {
  const desc = description.toLowerCase();
  
  // 1. PRIMARY FIXED BILLS (Credit Cards & Loans first to catch 'mobile' in CC payments)
  if (/ollo|credit.*card|visa|mastercard|payment.*thank.*you|discover|amex|marriott|capital.*one|chase/i.test(desc)) return { type: 'credit_card', name: 'Credit Cards', isFixed: true };
  if (/hyundai|santander|car.*payment|auto.*loan|vehicle.*loan/i.test(desc)) return { type: 'auto', name: 'Car Loans', isFixed: true };
  if (/mortgage|rent|lease|apartment|property|td bank mortgage/i.test(desc)) return { type: 'housing', name: 'Housing', isFixed: true };

  // 2. UTILITIES
  if (/pseg|electricity|gas|water|power|utility|hydro|pepco|eversource|constellation|coned/i.test(desc)) return { type: 'utilities', name: 'Utilities', isFixed: true };
  if (/internet|comcast|xfinity|fios|verizon|at&t|phone|mobile|wireless|cable|broadband|t-mobile/i.test(desc)) return { type: 'utilities', name: 'Internet/Phone', isFixed: true };
  if (/chargepoint|tesla\s?(supercharger|charging)|supercharger|blink|ev\s?charging|plugshare|electric\s?vehicle\s?charging/i.test(desc)) return { type: 'ev_charging', name: 'EV Charging', isFixed: false };
  
  // 3. INSURANCE
  if (/insurance|homeowners|renters|life.*ins|state farm|geico|allstate|usaa|progressive|amica|liberty mutual/i.test(desc)) return { type: 'insurance', name: 'Insurance', isFixed: true };
  
  // 4. SECONDARY & SUBSCRIPTIONS
  if (/uber.*eats|doordash|grubhub|seamless|restaurant|starbucks|mcdonalds/i.test(desc)) return { type: 'dining', name: 'Dining', isFixed: false };
  if (/netflix|amazon.*prime|prime.*video|spotify|hulu|disney|espn\+|hbo|iptv|apple tv|youtube|crunchyroll|paramount|peacock/i.test(desc)) return { type: 'subscriptions', name: 'Subscriptions', isFixed: false };
  if (/gym|fitness|peloton|yoga|membership|equinox|la fitness|orangetheory|planet/i.test(desc)) return { type: 'wellness', name: 'Fitness', isFixed: false };
  if (/office|microsoft|adobe|dropbox|onedrive|icloud|google one|amazon photos|backup/i.test(desc)) return { type: 'software', name: 'Software/Cloud', isFixed: false };
  if (/overdraft|bank fee|atm fee|wire transfer|td bank.*fee/i.test(desc)) return { type: 'banking', name: 'Banking Fees', isFixed: false };
  
  if (/subscription|membership|annual|yearly|monthly|recurring/i.test(desc)) return { type: 'subscription', name: 'Subscription', isFixed: false };
  
  return { type: 'subscription', name: 'Recurring Payment', isFixed: false };
}

router.post('/summary', async (req, res) => {
  try {
    const { dateFilter = 'current' } = req.body;
    const { startDate, endDate } = getDateRange(dateFilter);

    log('DASHBOARD', `Summary: ${startDate} to ${endDate}`);

    // 1. Get latest balance
    const latestBalance = await db.all(
       'SELECT balance FROM transactions WHERE user_id = $1 AND balance IS NOT NULL AND date::date <= CURRENT_DATE ORDER BY date::date DESC, id DESC LIMIT 1',
       [currentUserId()]
    );
    const balance = latestBalance.length > 0 ? Number(latestBalance[0].balance) : null;
    if (balance !== null && !Number.isFinite(balance)) throw new Error('Invalid account balance');

    // 2. Calculation of ACTUAL totals for the selected period (used for charts / AI analysis)
    const result = await db.get(
      `SELECT 
        SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) as total_income,
        SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) as total_expenses
      FROM transactions
      WHERE user_id = $1 AND date >= $2 AND date <= $3`,
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
       WHERE user_id = $1 
       ORDER BY date ASC, id ASC`,
      [currentUserId()]
    );

    const yearData = {};
    const monthsNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    for (const tx of rows) {
      if (isInternalTransfer(tx.description)) continue;
      if (/\b(x5261|x5237)\b/i.test(tx.description || '')) continue;

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
      is_fixed,
      pay_mode
    FROM transactions
    WHERE user_id = $1 AND date::date >= $2::date AND date::date <= $3::date`,
    [currentUserId(), dateString(previousMonth), dateString(today)]
  );
  const bills = buildUpcomingPayments(transactions, today);
  // Income and the flexible debt/goal plan are best-effort: bills still render if planning fails.
  let extras = [], plan = null, pro = false, streams = [];
  try {
    const [inputs, entitlement] = await Promise.all([loadPlanInputs(db, today), getEntitlement(req.user.id)]);
    pro = !!entitlement.active;
    const computed = computePlan(inputs, { pro: !!entitlement.plusActive, now: today });
    plan = entitlement.plusActive ? computed : null;
    streams = computed.income?.streams || [];
    extras = [...computed.incomeItems, ...(plan ? buildPlanPayments(plan, today) : [])];
  } catch (error) {
    log('DASHBOARD', `Upcoming plan items unavailable: ${error.message}`);
  }
  const items = [...bills, ...extras].sort((a, b) => a.dayOfMonth - b.dayOfMonth || Number(b.isIncome) - Number(a.isIncome));
  return { items, plan, pro, streams };
}

router.post('/upcoming-payments', async (req, res) => {
  try {
    log('DASHBOARD', 'Fetching monthly fixed payments based on the previous month');
    res.json((await loadUpcoming(req)).items);
  } catch (error) {
    log('DASHBOARD', `Error fetching upcoming payments: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/insights', async (req, res) => {
  try {
    const today = new Date();
    const [{ items, plan, pro, streams }, latest, count] = await Promise.all([
      loadUpcoming(req, today),
      db.all('SELECT balance FROM transactions WHERE user_id = $1 AND balance IS NOT NULL AND date::date <= CURRENT_DATE ORDER BY date::date DESC, id DESC LIMIT 1', [currentUserId()]),
      db.get("SELECT COUNT(*) AS total, MAX(created_at) AS last_import, to_char(MAX(date::date), 'YYYY-MM-DD') AS latest_date FROM transactions WHERE user_id = $1", [currentUserId()])
    ]);
    const balance = latest.length && Number.isFinite(Number(latest[0].balance)) ? Number(latest[0].balance) : null;
    let analytics = null;
    if (pro) {
      try {
        analytics = await db.transaction(async client => {
          const transactions = (await client.query('SELECT id, date, description, amount, direction, category, is_fixed, label_id FROM transactions ORDER BY date, id')).rows;
          const budgets = (await client.query('SELECT category, monthly_amount FROM category_budgets')).rows
            .map(row => ({ category: row.category, amount: Number(row.monthly_amount) }));
          return buildAnalytics({ transactions, budgets, latestBalance: balance, today });
        });
      } catch (error) {
        log('DASHBOARD', `Insight analytics unavailable: ${error.message}`);
      }
    }
    const lastImport = count?.last_import ? { at: new Date(count.last_import).toISOString(), latestDate: count.latest_date || null } : null;
    res.json(buildInsights({ today, balance, upcoming: items, plan, analytics, pro, hasData: Number(count?.total) > 0, incomeStreams: streams, lastImport }));
  } catch (error) {
    log('DASHBOARD', `Error building insights: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
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
      WHERE user_id = $1 AND date >= $2 AND date <= $3 AND UPPER(direction) = 'DEBIT'
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
        description,
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
      WHERE user_id = $1 AND UPPER(direction) = 'DEBIT'
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
        description,
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
        id,
        date,
        description,
        amount,
        direction,
        category,
        is_fixed,
        pay_mode,
        income_role,
        user_id
      FROM transactions
      WHERE user_id = $1
      ORDER BY date DESC
    `, [currentUserId()]);

    log('DASHBOARD', `Returning ${result.length} total transactions (including is_fixed)`);

    res.json({
      total: result.length,
      transactions: result.map(row => ({
        ...row,
        id: row.id.toString(),
        amount: parseFloat(row.amount),
        is_fixed: row.is_fixed === true || row.is_fixed === 1 || row.is_fixed === 'true',
        counts_as_income: isIncomeTransaction(row)
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
    const oldTxn = await db.get('SELECT id, description, category FROM transactions WHERE id = $1 AND user_id = $2', [transaction_id, currentUserId()]);
    
    if (!oldTxn) {
      log('CATEGORIZE', `❌ Transaction not found: ID ${transaction_id}`);
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const oldCategory = oldTxn.category || 'Uncategorized';

    // Update the transaction
    const validCategory = await db.get('SELECT id FROM categories WHERE name = $1', [new_category]);
    if (!validCategory) return res.status(400).json({ error: 'Choose one of your categories' });
    await db.run('UPDATE transactions SET category = $1, previous_category = category, category_corrected = TRUE, correction_timestamp = NOW() WHERE id = $2 AND user_id = $3', [new_category, transaction_id, currentUserId()]);

    log('CATEGORIZE', `✅ Updated transaction ${transaction_id}: "${oldTxn.description}" | ${oldCategory} → ${new_category}`);

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
