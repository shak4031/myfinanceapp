import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';

const router = Router();
const db = new Database();

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
      income: income,
      expenses: expenses,
      netCashflow: income - expenses,
      balance: balance
    });
  } catch (error) {
    log('DASHBOARD', `Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/upcoming-payments', async (req, res) => {
  try {
    log('DASHBOARD', 'Fetching upcoming payments');
    
    // Return array of payments directly - this is what frontend expects
    const payments = [
      { 
        type: 'income', 
        description: 'Paycheck (Biweekly)', 
        amount: 6211.68, 
        date: '2026-06-03' 
      },
      { 
        type: 'expense', 
        description: 'Mortgage', 
        amount: 1185.65, 
        date: '2026-06-01' 
      },
      { 
        type: 'expense', 
        description: 'Car Payment #1', 
        amount: 443.00, 
        date: '2026-06-04' 
      },
      { 
        type: 'expense', 
        description: 'Utilities', 
        amount: 150.00, 
        date: '2026-06-15' 
      },
      { 
        type: 'expense', 
        description: 'Car Payment #2', 
        amount: 513.00, 
        date: '2026-06-21' 
      },
      { 
        type: 'expense', 
        description: 'Insurance', 
        amount: 457.46, 
        date: '2026-06-28' 
      }
    ];
    
    log('DASHBOARD', `Returning ${payments.length} upcoming payments`);
    res.json(payments);
    
  } catch (error) {
    log('DASHBOARD', `Error fetching payments: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

export default router;
