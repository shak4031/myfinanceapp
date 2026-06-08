import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';

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
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0]
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
      [1, startDate, endDate]
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
        [1, month.month]
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
      [1]
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

    // Get latest balance (only forward-looking metric)
    const latestBalance = await db.all(
      'SELECT balance FROM transactions WHERE user_id = $1 ORDER BY date DESC, id DESC LIMIT 1',
      [1]
    );
    const balance = latestBalance.length > 0 ? parseFloat(latestBalance[0].balance) : 0;

    // Get historical averages from past 3 months (NOT period filter)
    const { avgIncome, avgExpenses, months } = await getHistoricalAverages();

    log('DASHBOARD', `Historical: Income avg $${avgIncome.toFixed(2)}, Expenses avg $${avgExpenses.toFixed(2)}`);

    res.json({
      income: avgIncome,
      expenses: avgExpenses,
      netCashflow: avgIncome - avgExpenses,
      balance: balance,
      period: { startDate, endDate },
      historicalMonths: months.map(m => ({
        month: m.month,
        income: parseFloat(m.monthly_income || 0),
        expenses: parseFloat(m.monthly_expenses || 0)
      }))
    });
  } catch (error) {
    log('DASHBOARD', `Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/upcoming-payments', async (req, res) => {
  try {
    log('DASHBOARD', 'Fetching upcoming payments (Strict Fixed Bills & Bi-weekly Projection)');

    const latestBalanceRes = await db.all(
      'SELECT balance FROM transactions WHERE user_id = $1 ORDER BY date DESC, id DESC LIMIT 1',
      [1]
    );
    const currentBalance = latestBalanceRes.length > 0 ? parseFloat(latestBalanceRes[0].balance) : 0;

    // 1. Get ALL transactions marked as fixed
    const fixedTransactions = await db.all(
      `SELECT 
        description,
        category,
        amount,
        EXTRACT(DAY FROM date::date) as day_of_month,
        date::date as actual_date,
        direction
      FROM transactions
      WHERE user_id = 1 
      AND is_fixed = TRUE
      ORDER BY date::date DESC`
    );

    // 2. Specialized Logic for Bi-weekly Wells Fargo Income
    const lastIncome = await db.all(
      `SELECT date::date, amount, description, category
       FROM transactions 
       WHERE user_id = 1 
       AND (description ~* 'WELLS FARGO.*PAYROLL|WELLS FARGO.*DIRECT DEP' OR is_fixed = TRUE)
       AND direction = 'CREDIT'
       ORDER BY date::date DESC
       LIMIT 1`
    );

    const timeline = [];
    const today = new Date();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();

    // Add fixed items from this month's records
    const seenDescriptions = new Set();
    fixedTransactions.forEach(tx => {
      const txDate = new Date(tx.actual_date);
      if (txDate.getMonth() === currentMonth && txDate.getFullYear() === currentYear) {
        timeline.push({
          description: tx.description,
          category: tx.category,
          amount: parseFloat(tx.amount),
          dayOfMonth: parseInt(tx.day_of_month),
          isIncome: tx.direction === 'CREDIT',
          status: 'processed'
        });
        seenDescriptions.add(`${tx.description}-${tx.amount}`);
      }
    });

    // 3. Project future occurrences of these fixed items for the rest of the month
    const uniqueFixed = [];
    const map = new Map();
    fixedTransactions.forEach(tx => {
      if (!map.has(tx.description)) {
        map.set(tx.description, tx);
        uniqueFixed.push(tx);
      }
    });

    uniqueFixed.forEach(tx => {
      const day = parseInt(tx.day_of_month);
      const key = `${tx.description}-${tx.amount}`;
      if (!seenDescriptions.has(key) && day > today.getDate()) {
        timeline.push({
          description: tx.description,
          category: tx.category,
          amount: parseFloat(tx.amount),
          dayOfMonth: day,
          isIncome: tx.direction === 'CREDIT',
          status: 'projected'
        });
      }
    });

    // 4. Bi-weekly Income Projection
    if (lastIncome.length > 0) {
      const lastDate = new Date(lastIncome[0].date);
      const nextDate = new Date(lastDate);
      nextDate.setDate(lastDate.getDate() + 14);

      if (nextDate.getMonth() === currentMonth && nextDate.getFullYear() === currentYear && nextDate.getDate() > today.getDate()) {
         timeline.push({
           description: 'Projected: Wells Fargo Payroll',
           category: 'Incomes',
           amount: parseFloat(lastIncome[0].amount),
           dayOfMonth: nextDate.getDate(),
           isIncome: true,
           status: 'projected'
         });
      }
    }

    timeline.sort((a, b) => a.dayOfMonth - b.dayOfMonth);
    res.json(timeline);
  } catch (error) {
    log('DASHBOARD', `Error fetching upcoming payments: ${error.message}`);
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
      [1, startDate, endDate]
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
      [1, category, startDate, endDate]
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
      [1]
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
      [1, category, startDate, endDate]
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
        user_id
      FROM transactions
      WHERE user_id = $1
      ORDER BY date DESC
    `, [1]);

    log('DASHBOARD', `Returning ${result.length} total transactions`);

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
    const oldTxn = await db.get('SELECT id, description, category FROM transactions WHERE id = $1 AND user_id = $2', [transaction_id, 1]);
    
    if (!oldTxn) {
      log('CATEGORIZE', `❌ Transaction not found: ID ${transaction_id}`);
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const oldCategory = oldTxn.category || 'Uncategorized';

    // Update the transaction
    await db.run('UPDATE transactions SET category = $1 WHERE id = $2 AND user_id = $3', [new_category, transaction_id, 1]);

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
    `, [1]);

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
