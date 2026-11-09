import { Router } from 'express';
import Database from '../db.js';
import { currentUserId } from '../utils/tenant.js';
import { buildLandscape } from '../utils/landscape.js';

const router = Router();
const db = new Database();
router.get('/', async (req, res, next) => {
  try {
    const userId = currentUserId();
    const inputs = await db.transaction(async client => ({
      accounts: (await client.query('SELECT id,name,kind,status,statement FROM accounts WHERE user_id=$1', [userId])).rows,
      transactions: (await client.query(`SELECT id,date,description,display_name,category,amount,direction,balance,
        account_id,plaid_account_id,is_fixed,is_pending,transfer_kind,transfer_account_id,transfer_pair_id,interest_kind,interest_override
        FROM transactions WHERE user_id=$1`, [userId])).rows,
      banks: (await client.query(`SELECT account_id,linked_account_id,account_link_error,subtype,current_balance,
        iso_currency_code,balance_checked_at FROM plaid_accounts WHERE user_id=$1`, [userId])).rows,
      debts: (await client.query('SELECT id,name,account_id,balance,min_payment,debt_type,payment_match FROM credit_cards WHERE user_id=$1', [userId])).rows,
      goals: (await client.query('SELECT id,name,current_amount,target_amount FROM savings_goals WHERE user_id=$1', [userId])).rows
    }));
    res.set('Cache-Control', 'no-store');
    res.json(buildLandscape(inputs));
  } catch (error) { next(error); }
});
export default router;
