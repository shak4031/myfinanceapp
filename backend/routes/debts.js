import { Router } from 'express';
import Database from '../db.js';

const router = Router();
const db = new Database();

router.post('/', async (req, res) => {
  try {
    const cards = await db.all('SELECT * FROM credit_cards WHERE user_id = 1');
    // Return formatted as array with card_name and other expected fields
    const debts = cards.map(c => ({
      card_name: c.name,
      balance: c.balance,
      apr: c.apr,
      limit: c.limit,
      paid_amount: c.limit - c.balance,
      id: c.id
    }));
    res.json(debts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
