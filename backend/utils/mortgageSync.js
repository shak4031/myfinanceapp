import { currentUserId, currentReadOnly } from './tenant.js';
import { failure } from './categorization.js';
import { monthIndex, monthFromIndex } from './amortization.js';
import { parseTxDate } from './normalize.js';

export const plaidAccountKind = account => account.type === 'credit' ? 'credit_card'
  : account.type === 'depository' && ['checking', 'savings'].includes(account.subtype) ? account.subtype
    : ['loan', 'investment'].includes(account.type) ? account.type : 'other';
const identity = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/bank$/, '');
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && parseTxDate(value)?.iso === value ? value : null;
const amount = value => Number.isFinite(value) && value >= 0 ? value : null;

export function plaidMortgageDetails(mortgage, account) {
  const term = String(mortgage.loan_term || '').match(/^(\d+)\s*(years?|months?)$/i);
  const months = term ? Number(term[1]) * (/year/i.test(term[2]) ? 12 : 1) : null;
  const maturity = date(mortgage.maturity_date);
  const escrow = amount(mortgage.escrow_balance);
  // escrow_balance is a reserve balance, not the monthly escrow payment.
  return {
    as_of: new Date().toISOString().slice(0, 10),
    balance: amount(account.balances?.current),
    apr: amount(mortgage.interest_rate?.percentage),
    original_amount: amount(mortgage.origination_principal_amount),
    term_months: months > 0 && months <= 600 ? months : null,
    first_payment_month: maturity && months > 0 && months <= 600
      ? monthFromIndex(monthIndex(maturity.slice(0, 7)) - months + 1) : null,
    first_payment_estimated: true,
    origination_date: date(mortgage.origination_date), maturity_date: maturity,
    interest_rate_type: mortgage.interest_rate?.type || null,
    interest_paid_ytd: amount(mortgage.ytd_interest_paid),
    reported_payment: amount(mortgage.next_monthly_payment),
    escrow_balance: escrow
  };
}

export async function ensurePlaidAccounts(client) {
  if (currentReadOnly()) return;
  const userId = currentUserId();
  await client.query('SELECT pg_advisory_xact_lock(74938121,$1::integer)', [userId]);
  const banks = (await client.query(`SELECT a.*,c.institution_name FROM plaid_accounts a
    JOIN plaid_connections c ON c.id=a.connection_id AND c.user_id=a.user_id
    WHERE a.user_id=$1 ORDER BY a.id`, [userId])).rows;
  for (const bank of banks) {
    if (bank.linked_account_id) continue;
    const kind = plaidAccountKind(bank);
    const identified = bank.mask ? (await client.query(`SELECT * FROM accounts
      WHERE user_id=$1 AND last4=$2 AND kind=$3 ORDER BY id FOR UPDATE`, [userId, bank.mask, kind])).rows
      .filter(account => identity(account.institution) && identity(account.institution) === identity(bank.institution_name)) : [];
    const confirmed = (await client.query(`SELECT a.* FROM accounts a WHERE a.user_id=$1 AND a.kind=$3
      AND a.id IN (SELECT account_id FROM transactions WHERE user_id=$1 AND plaid_account_id=$2 AND account_id IS NOT NULL)
      ORDER BY a.id FOR UPDATE`, [userId, bank.account_id, kind])).rows;
    const candidates = [...new Map([...identified, ...confirmed].map(account => [account.id, account])).values()];
    const duplicateConnections = banks.filter(other => other.mask && other.mask === bank.mask
      && identity(other.institution_name) === identity(bank.institution_name) && plaidAccountKind(other) === kind).length > 1;
    if (candidates.length > 1 || duplicateConnections) {
      await client.query("UPDATE plaid_accounts SET account_link_error='AMBIGUOUS_ACCOUNT' WHERE id=$1 AND user_id=$2", [bank.id, userId]);
      continue;
    }
    const account = candidates[0] || (await client.query(`INSERT INTO accounts(user_id,name,kind,institution,last4,status)
      VALUES($1,$2,$3,$4,$5,'active') RETURNING *`,
    [userId, bank.name.slice(0, 80), kind, bank.institution_name?.slice(0, 80) || null, bank.mask || null])).rows[0];
    await client.query('UPDATE plaid_accounts SET linked_account_id=$1,account_link_error=NULL WHERE id=$2 AND user_id=$3', [account.id, bank.id, userId]);
    await client.query(`UPDATE transactions SET account_id=$1 WHERE plaid_account_id=$2 AND user_id=$3 AND account_id IS NULL`,
      [account.id, bank.account_id, userId]);
  }
}

export async function applyMortgageEvidence(client, account, details, source, asOf, selectedDebtId, force = false) {
  const userId = currentUserId();
  if (!date(asOf) || !details || Object.entries(details).some(([key, value]) =>
    ['balance', 'apr', 'original_amount', 'escrow_payment', 'min_payment'].includes(key) &&
      value != null && (!Number.isFinite(value) || value < 0 || value > (key === 'apr' ? 40 : 100000000)))) {
    throw failure(422, 'Mortgage data contains invalid values. Review the source before importing.');
  }
  await client.query('SELECT pg_advisory_xact_lock(74938121,$1::integer)', [userId]);
  let debt = (await client.query(`SELECT * FROM credit_cards WHERE user_id=$1 AND account_id=$2 AND debt_type='mortgage' FOR UPDATE`,
    [userId, account.id])).rows[0];
  if (selectedDebtId != null && selectedDebtId !== 'new') {
    const selected = (await client.query(`SELECT * FROM credit_cards WHERE user_id=$1 AND id=$2 AND debt_type='mortgage' FOR UPDATE`,
      [userId, selectedDebtId])).rows[0];
    if (!selected || selected.account_id && selected.account_id !== account.id || debt && debt.id !== selected.id) {
      throw failure(409, 'That mortgage is already linked or is not available. Refresh and choose again.');
    }
    debt = selected;
  }
  if (!debt) {
    const unlinked = (await client.query(`SELECT * FROM credit_cards WHERE user_id=$1 AND debt_type='mortgage' AND account_id IS NULL ORDER BY id FOR UPDATE`,
      [userId])).rows;
    // A lender name alone is not proof that two loans are the same.
    if (unlinked.length && selectedDebtId !== 'new') return { needsLink: true, accountId: account.id };
    debt = (await client.query(`INSERT INTO credit_cards(user_id,name,debt_type,balance,apr,min_payment,included,account_id)
      VALUES($1,$2,'mortgage',NULL,NULL,0,FALSE,$3) RETURNING *`, [userId, account.name, account.id])).rows[0];
  }
  if (debt.mortgage_data_as_of && asOf < debt.mortgage_data_as_of) return { id: debt.id };
  if (!selectedDebtId && asOf === debt.mortgage_data_as_of &&
    ((!force && source === debt.mortgage_source) || (source === 'plaid' && debt.mortgage_source === 'statement'))) return { id: debt.id };
  const fields = ['balance', 'apr', 'original_amount', 'term_months', 'escrow_payment', 'min_payment',
    'origination_date', 'maturity_date', 'first_payment_month'];
  const updates = Object.fromEntries(fields.filter(key => details[key] != null).map(key => [key, details[key]]));
  // A first payment derived from maturity is only a starting estimate; keep an explicit manual month.
  if (details.first_payment_estimated && debt.first_payment_month) delete updates.first_payment_month;
  const keys = Object.keys(updates);
  await client.query(`UPDATE credit_cards SET account_id=$1,mortgage_source=$2,mortgage_data_as_of=$3
    ${keys.map((key, i) => `,${key}=$${i + 4}`).join('')} WHERE id=$${keys.length + 4} AND user_id=$${keys.length + 5}`,
  [account.id, source, asOf, ...Object.values(updates), debt.id, userId]);
  return { id: debt.id };
}

export async function refreshMortgageAccounts(client, force = false, connectionId = null) {
  if (currentReadOnly()) return;
  await ensurePlaidAccounts(client);
  const banks = (await client.query(`SELECT a.linked_account_id,a.mortgage_details,a.balance_checked_at
    FROM plaid_accounts a WHERE a.user_id=$1 AND a.mortgage_details IS NOT NULL
      AND ($2::integer IS NULL OR a.connection_id=$2)`, [currentUserId(), connectionId])).rows;
  for (const bank of banks) {
    const account = (await client.query('SELECT * FROM accounts WHERE id=$1 AND user_id=$2', [bank.linked_account_id, currentUserId()])).rows[0];
    if (account) await applyMortgageEvidence(client, account, bank.mortgage_details, 'plaid', bank.mortgage_details.as_of, undefined, force);
  }
}
