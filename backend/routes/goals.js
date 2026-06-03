import { Router } from 'express';
import Database from '../db.js';

const router = Router();
const db = new Database();

router.post('/', async (req, res) => {
  try {
    const goals = await db.all('SELECT * FROM savings_goals WHERE user_id = 1');
    // Return formatted as array with expected field names
    const formattedGoals = goals.map(g => ({
      id: g.id,
      name: g.name,
      target_amount: g.target,
      current_amount: g.current,
      deadline: g.deadline
    }));
    res.json(formattedGoals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
