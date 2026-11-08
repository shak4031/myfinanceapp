import { Router } from 'express';
import Database from '../db.js';
import { requireProPlus } from '../utils/license.js';
import { simulateMortgage } from '../utils/amortization.js';

const router = Router();
router.use(requireProPlus);
const db = new Database();
const number = value => value == null ? null : Number(value);

function mortgageRow(row) {
  return {
    id: row.id, name: row.name, balance: number(row.balance), apr: number(row.apr),
    min_payment: number(row.min_payment), due_date: row.due_date,
    original_amount: number(row.original_amount), term_months: number(row.term_months),
    first_payment_month: row.first_payment_month, escrow_payment: number(row.escrow_payment),
    payment_match: row.payment_match, included: row.included !== false
  };
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await db.all(`SELECT * FROM credit_cards WHERE debt_type='mortgage' ORDER BY id`);
    const mortgages = rows.map(mortgageRow).map(row => {
      if (!(row.original_amount > 0) || !(row.term_months > 0)) return { ...row, simulation: null };
      try {
        return { ...row, simulation: simulateMortgage({ ...row, currentBalance: row.balance > 0 ? row.balance : null }) };
      } catch {
        return { ...row, simulation: null };
      }
    });
    res.json({ mortgages });
  } catch (error) { next(error); }
});

router.post('/simulate', (req, res, next) => {
  try {
    res.json(simulateMortgage(req.body || {}));
  } catch (error) { next(error); }
});

export default router;
