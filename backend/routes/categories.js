import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';
import { currentUserId } from '../utils/tenant.js';
import { failure } from '../utils/categorization.js';
import { recordAudit } from '../utils/audit.js';

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
    const { name, icon = '📦', color = '#424242' } = req.body || {};
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName || cleanName.length > 100) throw failure(400, 'Category name must contain 1 to 100 characters');
    log('CATEGORIES', `Creating new category: ${cleanName}`);
    const result = await db.run(
      'INSERT INTO categories (name, icon, color) VALUES ($1, $2, $3) RETURNING id,name,icon,color',
      [cleanName, icon, color]
    );
    await recordAudit(req, 'category.created', 'success', {
      detail: { categoryId: result.rows[0].id, category: result.rows[0].name }
    });
    res.status(201).json({ success: true, category: result.rows[0] });
  } catch (err) {
    log('CATEGORIES', `❌ Error creating category: ${err.message}`, err.code === '23505' || err.status < 500 ? 'warn' : 'error');
    res.status(err.status || (err.code === '23505' ? 409 : 500)).json({
      error: err.code === '23505' ? 'A category with that name already exists' : err.message
    });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!Number.isSafeInteger(id) || id < 1) throw failure(400, 'A valid category id is required');
    if (!name || name.length > 100) throw failure(400, 'Category name must contain 1 to 100 characters');
    let previousName;
    const category = await db.transaction(async client => {
      const userId = currentUserId();
      const current = (await client.query('SELECT id,name FROM categories WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId])).rows[0];
      if (!current) throw failure(404, 'Category not found');
      previousName = current.name;
      const renamed = (await client.query('UPDATE categories SET name=$1 WHERE id=$2 AND user_id=$3 RETURNING id,name,icon,color',
        [name, id, userId])).rows[0];
      await client.query('UPDATE transactions SET category=$1 WHERE user_id=$2 AND category=$3',
        [name, userId, current.name]);
      return renamed;
    });
    await recordAudit(req, 'category.renamed', 'success', {
      detail: { categoryId: category.id, previousCategory: previousName, category: category.name }
    });
    res.json({ success: true, category });
  } catch (err) {
    log('CATEGORIES', `❌ Error renaming category: ${err.message}`);
    res.status(err.status || (err.code === '23505' ? 409 : 500)).json({
      error: err.code === '23505' ? 'A category with that name already exists' : err.message
    });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const replacementId = Number(req.body?.replacementId);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(replacementId) || replacementId < 1 || replacementId === id) {
      throw failure(400, 'Choose a different existing category to receive these transactions and merchant rules');
    }
    const moved = await db.transaction(async client => {
      const ownerId = currentUserId();
      const rows = (await client.query('SELECT id,name FROM categories WHERE user_id=$1 AND id=ANY($2::integer[]) FOR UPDATE', [ownerId, [id, replacementId]])).rows;
      const source = rows.find(row => Number(row.id) === id);
      const replacement = rows.find(row => Number(row.id) === replacementId);
      if (!source || !replacement) throw failure(404, 'Category or replacement category not found');
      const transactions = await client.query(
        'UPDATE transactions SET previous_category=category,category=$1 WHERE user_id=$2 AND category=$3',
        [replacement.name, ownerId, source.name]
      );
      await client.query('UPDATE transaction_labels SET category_id=$1 WHERE user_id=$2 AND category_id=$3',
        [replacementId, ownerId, id]);
      await client.query('DELETE FROM categories WHERE id=$1 AND user_id=$2', [id, ownerId]);
      return { transactions: transactions.rowCount, sourceCategory: source.name, replacementCategory: replacement.name };
    });
    await recordAudit(req, 'category.deleted', 'success', {
      detail: { category: moved.sourceCategory, replacementCategory: moved.replacementCategory, transactionsMoved: moved.transactions }
    });
    delete moved.sourceCategory;
    delete moved.replacementCategory;
    res.json({ success: true, ...moved });
  } catch (err) {
    log('CATEGORIES', `❌ Error deleting category: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
