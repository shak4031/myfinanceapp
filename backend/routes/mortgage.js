import { Router } from 'express';
import Database from '../db.js';
import { requireProPlus } from '../utils/license.js';
import { simulateMortgage } from '../utils/amortization.js';
import { applyMortgageEvidence, refreshMortgageAccounts } from '../utils/mortgageSync.js';
import { currentUserId } from '../utils/tenant.js';
import { failure } from '../utils/categorization.js';

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
    payment_match: row.payment_match, included: row.included !== false,
    account_id: row.account_id, origination_date: row.origination_date, maturity_date: row.maturity_date,
    mortgage_source: row.mortgage_source, mortgage_data_as_of: row.mortgage_data_as_of
  };
}

router.get('/', async (req, res, next) => {
  try {
    await db.transaction(refreshMortgageAccounts);
    const rows = await db.all(`SELECT * FROM credit_cards WHERE debt_type='mortgage' ORDER BY id`);
    const mortgages = rows.map(mortgageRow).map(row => {
      if (!(row.original_amount > 0) || !(row.term_months > 0) || row.apr == null || !row.first_payment_month) return { ...row, simulation: null };
      try {
        return { ...row, simulation: simulateMortgage({ ...row, currentBalance: row.balance }) };
      } catch (error) {
        if (!error.status) throw error;
        return { ...row, simulation: null, simulationError: error.message };
      }
    });
    const sources = await db.all(`SELECT a.id,a.name,a.last4,a.statement,pa.mortgage_details,c.liabilities_error_code
      FROM accounts a LEFT JOIN plaid_accounts pa ON pa.linked_account_id=a.id AND pa.user_id=a.user_id
      LEFT JOIN plaid_connections c ON c.id=pa.connection_id AND c.user_id=a.user_id
      WHERE a.kind='loan' AND (pa.subtype='mortgage' OR a.statement->>'type'='mortgage')
      ORDER BY a.id`);
    res.json({ mortgages, sources: sources.map(account => ({
      accountId: account.id, name: account.name, last4: account.last4,
      linked: mortgages.some(mortgage => mortgage.account_id === account.id),
      errorCode: account.liabilities_error_code,
      details: sourceEvidence(account)?.details || null
    })) });
  } catch (error) { next(error); }
});

function sourceEvidence(account) {
  const statement = account.statement?.type === 'mortgage' ? account.statement : null;
  const plaid = account.mortgage_details;
  return statement && (!plaid || statement.closingDate >= plaid.as_of)
    ? { details: statement.mortgage, source: 'statement', asOf: statement.closingDate }
    : plaid ? { details: plaid, source: 'plaid', asOf: plaid.as_of } : null;
}

router.post('/link', async (req, res, next) => {
  try {
    const accountId = Number(req.body?.accountId);
    const debtId = req.body?.debtId === 'new' ? 'new' : Number(req.body?.debtId);
    if (!Number.isSafeInteger(accountId) || accountId < 1 ||
      (debtId !== 'new' && (!Number.isSafeInteger(debtId) || debtId < 1))) throw failure(400, 'Choose an account and a mortgage to link.');
    const result = await db.transaction(async client => {
      const account = (await client.query(`SELECT a.*,pa.mortgage_details FROM accounts a
        LEFT JOIN plaid_accounts pa ON pa.linked_account_id=a.id AND pa.user_id=a.user_id
        WHERE a.id=$1 AND a.user_id=$2 AND a.kind='loan' FOR UPDATE OF a`, [accountId, currentUserId()])).rows[0];
      const evidence = account && sourceEvidence(account);
      if (!evidence) throw failure(409, 'Mortgage details have not arrived. Sync this connection or import a mortgage statement first.');
      return applyMortgageEvidence(client, account, evidence.details, evidence.source, evidence.asOf, debtId);
    });
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

router.post('/simulate', (req, res, next) => {
  try {
    res.json(simulateMortgage(req.body || {}));
  } catch (error) { next(error); }
});

export default router;
