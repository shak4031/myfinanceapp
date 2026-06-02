import { Router } from 'express';
import Database from '../db.js';

const router = Router();
const db = new Database();
await db.init();

router.get('/', async (req, res) => {
  const goals = await db.all('SELECT * FROM savings_goals WHERE user_id = 1');
  res.json({ goals });
});

export default router;
