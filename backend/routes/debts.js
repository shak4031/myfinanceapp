import { Router } from 'express';
import Database from '../db.js';

const router = Router();
const db = new Database();

router.post('/', async (req, res) => {
  try {
    const cards = await db.all('SELECT name as card_name, balance, apr, credit_limit as "limit", min_payment FROM credit_cards');
    res.json(cards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
