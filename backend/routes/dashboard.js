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

router.post('/summary', async (req, res) => {
  try {
    const { dateFilter = 'current' } = req.body;
    const { startDate, endDate } = getDateRange(dateFilter);

    log('DASHBOARD', `Summary: ${startDate} to ${endDate}`);

    // Get all transactions to find latest balance
    const allTxns = await db.all(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY date DESC, id DESC LIMIT 1',
      [1]
    );

    // Get filtered transactions
    const txns = await db.all(
      'SELECT * FROM transactions WHERE user_id = $1 AND date >= $2 AND date <= $3 ORDER BY date DESC',
      [1, startDate, endDate]
    );

    let income = 0, expenses = 0;
    txns.forEach(tx => {
      if (tx.direction === 'credit') income += parseFloat(tx.amount);
      else expenses += parseFloat(tx.amount);
    });

    const balance = allTxns.length > 0 ? parseFloat(allTxns[0].balance) : 0;

    res.json({
      income: income,
      expenses: expenses,
      netCashflow: income - expenses,
      balance: balance,
      period: { startDate, endDate }
    });
  } catch (error) {
    log('DASHBOARD', `Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/upcoming-payments', async (req, res) => {
  try {
    log('DASHBOARD', 'Fetching upcoming payments with smart cascade');

    // Get current balance
    const balanceRes = await db.all(
      'SELECT balance FROM transactions WHERE user_id = $1 ORDER BY date DESC LIMIT 1',
      [1]
    );
    const currentBalance = balanceRes.length > 0 ? parseFloat(balanceRes[0].balance) : 0;

    // Hardcoded upcoming payments with smart cascade logic
    const basePayments = [
      { type: 'income', description: 'Paycheck (Biweekly)', amount: 6211.68, date: '2026-06-06' },
      { type: 'expense', description: 'Mortgage', amount: 1185.65, date: '2026-06-01' },
      { type: 'expense', description: 'Car Payment #1', amount: 443.00, date: '2026-06-04' },
      { type: 'expense', description: 'Utilities', amount: 150.00, date: '2026-06-15' },
      { type: 'expense', description: 'Car Payment #2', amount: 513.00, date: '2026-06-21' },
      { type: 'income', description: 'Paycheck (Biweekly)', amount: 6211.68, date: '2026-06-20' },
      { type: 'expense', description: 'Insurance', amount: 457.46, date: '2026-06-28' }
    ];

    // Sort by date
    basePayments.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Calculate cascading balance
    let cascadeBalance = currentBalance;
    const payments = basePayments.map(p => {
      const isIncome = p.type === 'income';
      const newBalance = isIncome ? cascadeBalance + p.amount : cascadeBalance - p.amount;
      
      const payment = {
        ...p,
        balanceBefore: cascadeBalance,
        balanceAfter: newBalance
      };

      cascadeBalance = newBalance;
      return payment;
    });

    log('DASHBOARD', `Returning ${payments.length} upcoming payments`);
    res.json(payments);
  } catch (error) {
    log('DASHBOARD', `Error fetching payments: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
