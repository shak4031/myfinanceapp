import { attemptKeysForEmail } from '../routes/auth.js';

const USER_TABLES = ['transaction_import_reviews', 'transactions', 'transaction_labels', 'accounts', 'import_batches',
  'plaid_accounts', 'plaid_connections', 'staging_transactions', 'credit_cards', 'savings_goals', 'categories',
  'category_budgets', 'money_plans', 'household_profiles', 'name_rules', 'import_reviews'];

// Removes every record owned by an account and then the login itself. Callers must lock and validate the target first.
export async function removeAccountRecords(client, target) {
  const counts = {};
  for (const table of USER_TABLES) counts[table] = (await client.query(`DELETE FROM ${table} WHERE user_id=$1`, [target.id])).rowCount;
  await client.query('DELETE FROM household_invitations WHERE invited_by=$1', [target.id]);
  await client.query('DELETE FROM auth_attempts WHERE key = ANY($1)', [attemptKeysForEmail(target.email)]);
  if (target.household_role === 'owner') {
    await client.query('DELETE FROM household_invitations WHERE household_id=$1', [target.household_id]);
    await client.query('DELETE FROM household_subscriptions WHERE household_id=$1', [target.household_id]);
    await client.query('DELETE FROM households WHERE id=$1', [target.household_id]);
  } else {
    await client.query('DELETE FROM household_members WHERE user_id=$1', [target.id]);
  }
  const result = await client.query('DELETE FROM users WHERE id=$1 AND email=$2 RETURNING id', [target.id, target.email]);
  if (!result.rowCount) throw new Error('The account changed during deletion.');
  return counts;
}
