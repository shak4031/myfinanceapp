import { Router } from 'express';
import Database from '../db.js';

const router = Router();
const db = new Database();
await db.init();

router.get('/', async (req, res) => {
  const cards = await db.all('SELECT * FROM credit_cards WHERE user_id = 1');
  res.json({ 
    cards,
    totalDebt: cards.reduce((sum, c) => sum + c.balance, 0),
    payoffMonths: 13
  });
});

export default router;
