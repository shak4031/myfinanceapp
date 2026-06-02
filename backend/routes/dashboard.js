import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';

const router = Router();
const db = new Database();
await db.init();

router.post('/summary', async (req, res) => {
  try {
    log('DASHBOARD', 'Fetching summary');
    
    // Get transactions
    const txns = await db.all('SELECT * FROM transactions WHERE user_id = 1 ORDER BY date DESC LIMIT 90');
    
    // Calculate metrics
    let income = 0, expenses = 0;
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    
    txns.forEach(tx => {
      const txDate = new Date(tx.date);
      if (txDate >= monthStart && txDate <= monthEnd) {
        if (tx.direction === 'credit') income += tx.amount;
        else expenses += tx.amount;
      }
    });
    
    const balance = txns.length > 0 ? txns[0].balance : 0;
    
    res.json({
      currentBalance: balance,
      monthlyIncome: income,
      monthlyExpenses: expenses,
      netCashFlow: income - expenses,
      transactions: txns.slice(0, 20)
    });
  } catch (error) {
    log('DASHBOARD', `Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/upcoming-payments', async (req, res) => {
  try {
    log('DASHBOARD', 'Fetching upcoming payments');
    
    // Fixed bills (recurring)
    const bills = [
      { name: 'Mortgage', amount: 1185.65, dueDate: '1st', category: 'Housing' },
      { name: 'Car Payment #1', amount: 443.00, dueDate: '4th', category: 'Auto' },
      { name: 'Utilities', amount: 150.00, dueDate: '15th', category: 'Utilities' },
      { name: 'Car Payment #2', amount: 513.00, dueDate: '21st', category: 'Auto' },
      { name: 'Insurance', amount: 457.46, dueDate: '28th', category: 'Insurance' },
    ];
    
    const txns = await db.all('SELECT * FROM transactions WHERE user_id = 1 ORDER BY date DESC LIMIT 1');
    const currentBalance = txns.length > 0 ? txns[0].balance : 0;
    
    let projectedBalance = currentBalance;
    bills.forEach(b => projectedBalance -= b.amount);
    
    res.json({
      currentBalance,
      projectedBalance,
      totalRemaining: bills.reduce((sum, b) => sum + b.amount, 0),
      bills,
      items: [
        { type: 'income', name: 'Paycheck (Biweekly)', amount: 6211.68, date: '2026-06-03' },
        ...bills.map((b, i) => ({ 
          type: 'expense', 
          name: b.name, 
          amount: b.amount, 
          date: `2026-06-${b.dueDate.replace('st', '').replace('nd', '').replace('rd', '').replace('th', '')}` 
        }))
      ].sort((a, b) => new Date(a.date) - new Date(b.date))
    });
  } catch (error) {
    log('DASHBOARD', `Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
