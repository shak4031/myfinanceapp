import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';

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
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0]
  };
}

// Helper: Calculate 3-month historical averages
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
    
    const avgIncome = result.reduce((sum, m) => sum + (parseFloat(m.monthly_income) || 0), 0) / result.length;
    const avgExpenses = result.reduce((sum, m) => sum + (parseFloat(m.monthly_expenses) || 0), 0) / result.length;
    
    log('DASHBOARD', `Historical averages: Income $${avgIncome.toFixed(2)}, Expenses $${avgExpenses.toFixed(2)}`);
    
    return { avgIncome, avgExpenses, months: result };
  } catch (error) {
    log('DASHBOARD', `Error calculating historical averages: ${error.message}`);
    return { avgIncome: 0, avgExpenses: 0, months: [] };
  }
}

// Helper: Detect recurring payments (subscriptions, bills)
async function getRecurringPayments() {
  try {
    const result = await db.all(
      `SELECT 
        description,
        amount,
        EXTRACT(DAY FROM date::date) as day_of_month,
        COUNT(*) as frequency,
        MAX(date) as last_date
      FROM transactions
      WHERE user_id = $1 AND UPPER(direction) = 'DEBIT'
      GROUP BY description, amount, EXTRACT(DAY FROM date::date)
      HAVING COUNT(*) >= 2
      ORDER BY frequency DESC, last_date DESC`,
      [1]
    );
    
    return result.filter(p => {
      const recurring = p.frequency >= 2;
      const isSubscription = /netflix|prime|spotify|hulu|subscription|monthly|fee|bill|payment|insurance|mortgage|utilities/i.test(p.description);
      return recurring || isSubscription;
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
  
  // Streaming services
  if (/amazon.*prime|prime.*video/i.test(desc)) return { type: 'streaming', name: 'Prime Video' };
  if (/netflix/i.test(desc)) return { type: 'streaming', name: 'Netflix' };
  if (/spotify/i.test(desc)) return { type: 'streaming', name: 'Spotify' };
  if (/hulu/i.test(desc)) return { type: 'streaming', name: 'Hulu' };
  if (/disney|espn\+|hbo/i.test(desc)) return { type: 'streaming', name: 'Streaming Service' };
  if (/iptv|apple tv|youtube|crunchyroll|paramount|peacock/i.test(desc)) return { type: 'streaming', name: 'IPTV/Streaming' };
  
  // Utilities & Internet  
  if (/internet|comcast|verizon|at&t|phone|mobile|wireless|cable|broadband/i.test(desc)) return { type: 'utilities', name: 'Internet/Phone' };
  if (/electricity|gas|water|power|utility|hydro|pepco|eversource/i.test(desc)) return { type: 'utilities', name: 'Utilities' };
  
  // Insurance (needs to come BEFORE generic subscription)
  if (/insurance|homeowners|renters|auto|health|state farm|geico|allstate|usaa|progressive|amica/i.test(desc)) return { type: 'insurance', name: 'Insurance' };
  
  // Housing & Auto
  if (/mortgage|rent|lease|apartment|housing|property/i.test(desc)) return { type: 'housing', name: 'Housing' };
  if (/car.*payment|auto.*loan|vehicle|bmw|ford|tesla|honda|chevy|payment/i.test(desc)) return { type: 'auto', name: 'Car Payment' };
  
  // Wellness & Fitness
  if (/gym|fitness|peloton|yoga|membership|equinox|la fitness|orangetheory|planet/i.test(desc)) return { type: 'wellness', name: 'Fitness' };
  if (/healthcare|medical|doctor|dentist|dental|pharmacy|cvs|walgreens|chiropractor|physical therapy/i.test(desc)) return { type: 'wellness', name: 'Healthcare' };
  
  // Software & Cloud
  if (/office|microsoft|adobe|dropbox|onedrive|icloud|google one|amazon photos|backup/i.test(desc)) return { type: 'software', name: 'Software/Cloud' };
  
  // Banking & Finance (fees, overdraft, etc)
  if (/overdraft|bank fee|atm fee|wire transfer|td bank|chase|wells fargo|bofa|bank of america/i.test(desc)) return { type: 'banking', name: 'Banking Fees' };
  
  // Business & Professional
  if (/accounting|bookkeeping|lawyer|legal|consulting|freelance|visa fee|merchant|payment|square|stripe/i.test(desc)) return { type: 'professional', name: 'Professional Services' };
  
  // Subscriptions (catch-all, last resort)
  if (/subscription|membership|annual|yearly|monthly|recurring/i.test(desc)) return { type: 'subscription', name: 'Subscription' };
  
  return { type: 'subscription', name: 'Recurring Payment' };
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

    log('DASHBOARD', `Historical: Income avg $${avgIncome.toFixed(2)}, Expenses avg $${avgExpenses.toFixed(2)}`);;

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

router.post('/recurring-payments', async (req, res) => {
  try {
    log('DASHBOARD', 'Fetching recurring payments (subscriptions/bills)');

    const recurring = await getRecurringPayments();
    
    // Categorize subscriptions
    const categorized = recurring.map(p => ({
      ...p,
      category: categorizeSubscription(p.description)
    }));

    log('DASHBOARD', `Found ${categorized.length} recurring payments`);
    res.json(categorized);
  } catch (error) {
    log('DASHBOARD', `Error fetching recurring payments: ${error.message}`);
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

export default router;
