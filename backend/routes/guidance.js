import { Router } from 'express';
import Database from '../db.js';
import { currentUserId } from '../utils/tenant.js';
import { listTransactionDuplicates } from '../utils/transactionDuplicates.js';
import { buildFinancialFindings } from '../utils/financialFindings.js';

const router = Router();
const db = new Database();

router.get('/', async (req, res, next) => {
  if (req.support) return res.status(403).json({ error: 'End the support session to use your own assistant.' });
  try {
    // The standard runtime transaction enforces the signed-in household's RLS.
    // Never accept a customer/household ID from the browser or use the admin pool.
    const findings = await db.transaction(async client => {
      const transactions = (await client.query(`SELECT id,date,description,display_name,amount,direction,
        category,transfer_kind,income_role,is_fixed,is_pending,note FROM transactions
        WHERE user_id=$1`, [currentUserId()])).rows;
      const budgets = (await client.query('SELECT category,monthly_amount FROM category_budgets WHERE user_id=$1', [currentUserId()])).rows;
      const connections = (await client.query(`SELECT id,institution_name,status,last_sync_at
        FROM plaid_connections WHERE user_id=$1`, [currentUserId()])).rows;
      const { total } = await listTransactionDuplicates(client);
      return buildFinancialFindings({ transactions, budgets, connections, duplicateCount: total });
    });
    res.json(findings);
  } catch (error) { next(error); }
});

export default router;
