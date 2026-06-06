import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';

const router = Router();
const db = new Database();

// GET /api/categories - Get all categories
router.get('/', async (req, res) => {
  try {
    log('CATEGORIES', 'Fetching all categories');
    
    const categories = await db.all(
      'SELECT id, name, icon, color FROM categories ORDER BY name ASC'
    );
    
    log('CATEGORIES', `✓ Found ${categories.length} categories`);
    res.json(categories);
  } catch (err) {
    log('CATEGORIES', `❌ Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categories - Create a new category
router.post('/', async (req, res) => {
  try {
    const { name, icon = '📦', color = '#424242' } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }
    
    log('CATEGORIES', `Creating new category: ${name}`);
    
    await db.run(
      'INSERT INTO categories (name, icon, color) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
      [name, icon, color]
    );
    
    res.json({ success: true, message: `Category ${name} created` });
  } catch (err) {
    log('CATEGORIES', `❌ Error creating category: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
