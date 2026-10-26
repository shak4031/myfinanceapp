import express from 'express';
import { administrativeTransaction } from '../db.js';
import Database from '../db.js';
import { withUser, currentUserId } from '../utils/tenant.js';
import { failure, loadCategorization } from '../utils/categorization.js';
import { importTransactions } from '../utils/transactionImport.js';
import {
  decryptPlaidToken, encryptPlaidToken, getPlaidClient, plaidErrorCode, verifyPlaidWebhook
} from '../utils/plaid.js';

const plaidRouter = express.Router();
const webhookRouter = express.Router();
const db = new Database();

function plaidWebhookUrl() {
  let origin;
  try { origin = new URL(process.env.APP_ORIGIN); } catch {
    throw failure(503, 'Set APP_ORIGIN to the public application origin before enabling Plaid');
  }
  if (!origin || origin.origin !== process.env.APP_ORIGIN || (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:')) {
    throw failure(503, 'Set APP_ORIGIN to the public application origin before enabling Plaid');
  }
  return `${origin.origin}/api/plaid/webhook`;
}

function plaidTransaction(row) {
  if (!row || typeof row.transaction_id !== 'string' || !row.transaction_id
    || typeof row.account_id !== 'string' || !row.account_id
    || typeof row.amount !== 'number' || !Number.isFinite(row.amount)) {
    throw new Error('Plaid returned an invalid transaction record');
  }
  return {
    date: row.date,
    description: row.merchant_name || row.name,
    amount: Math.abs(row.amount),
    direction: row.amount < 0 ? 'DEBIT' : 'CREDIT',
    balance: null,
    plaidTransactionId: row.transaction_id,
    plaidAccountId: row.account_id,
    isPending: row.pending === true,
    pendingTransactionId: row.pending_transaction_id || null
  };
}

async function saveAccounts(client, connectionId, accounts) {
  const userId = currentUserId();
  for (const account of accounts) {
    if (typeof account.account_id !== 'string' || !account.account_id || typeof account.name !== 'string') {
      throw new Error('Plaid returned an invalid account record');
    }
    const balance = account.balances || {};
    const currency = balance.iso_currency_code || balance.unofficial_currency_code || null;
    await client.query(`INSERT INTO plaid_accounts
      (connection_id,account_id,name,official_name,mask,type,subtype,current_balance,available_balance,
        iso_currency_code,use_for_cashflow,balance_checked_at,user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12)
      ON CONFLICT (user_id,account_id) DO UPDATE SET
        connection_id=EXCLUDED.connection_id, name=EXCLUDED.name, official_name=EXCLUDED.official_name,
        mask=EXCLUDED.mask, type=EXCLUDED.type, subtype=EXCLUDED.subtype,
        current_balance=EXCLUDED.current_balance, available_balance=EXCLUDED.available_balance,
        iso_currency_code=EXCLUDED.iso_currency_code, balance_checked_at=NOW()`,
    [connectionId, account.account_id, account.name, account.official_name || null, account.mask || null,
      account.type || null, account.subtype || null,
      Number.isFinite(balance.current) ? balance.current : null,
      Number.isFinite(balance.available) ? balance.available : null, currency,
      account.type === 'depository' && account.subtype === 'checking' && currency === 'USD', userId]);
  }
}

async function fetchAllChanges(plaidClient, accessToken, savedCursor) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor = savedCursor || undefined;
    const added = [];
    const modified = [];
    const removed = [];
    try {
      let response;
      do {
        response = await plaidClient.transactionsSync({
          access_token: accessToken,
          ...(cursor ? { cursor } : {})
        });
        added.push(...response.data.added);
        modified.push(...response.data.modified);
        removed.push(...response.data.removed);
        cursor = response.data.next_cursor;
      } while (response.data.has_more);
      return { added, modified, removed, cursor };
    } catch (error) {
      if (plaidErrorCode(error) !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' || attempt === 2) throw error;
    }
  }
  throw new Error('Plaid transaction pagination could not be completed');
}

async function refreshPlaidAccountBalances(client, connectionId, accessToken, plaidClient) {
  const accounts = (await plaidClient.accountsGet({ access_token: accessToken })).data.accounts;
  await saveAccounts(client, connectionId, accounts);
}

async function reconcilePostedTransaction(client, posted) {
  if (!posted.pendingTransactionId) return false;
  const pending = (await client.query(`SELECT id FROM transactions
    WHERE plaid_transaction_id=$1 AND user_id=current_setting('app.user_id')::integer
    FOR UPDATE`, [posted.pendingTransactionId])).rows[0];
  if (pending) {
    await client.query(`UPDATE transactions SET plaid_transaction_id=$1, plaid_account_id=$2,
        date=$3,description=$4,amount=$5,direction=$6,is_pending=FALSE
      WHERE id=$7`, [posted.plaidTransactionId, posted.plaidAccountId, posted.date, posted.description,
      posted.amount, posted.direction, pending.id]);
    return true;
  }
  const review = (await client.query(`SELECT id FROM transaction_import_reviews
    WHERE plaid_transaction_id=$1 AND user_id=current_setting('app.user_id')::integer
      AND status IN ('pending','duplicate') FOR UPDATE`, [posted.pendingTransactionId])).rows[0];
  if (review) {
    await client.query(`UPDATE transaction_import_reviews SET plaid_transaction_id=$1, plaid_account_id=$2,
        date=$3,description=$4,amount=$5,direction=$6,is_pending=FALSE
      WHERE id=$7`, [posted.plaidTransactionId, posted.plaidAccountId, posted.date,
      posted.description, posted.amount, posted.direction, review.id]);
    return true;
  }
  return false;
}

async function syncConnection(client, connectionId, onlyIfDue = false) {
  const connection = (await client.query(`SELECT * FROM plaid_connections
    WHERE id=$1 AND user_id=current_setting('app.user_id')::integer
    FOR UPDATE`, [connectionId])).rows[0];
  if (!connection) throw failure(404, 'Connected bank account not found');
  if (onlyIfDue && connection.last_sync_at
    && Date.now() - new Date(connection.last_sync_at).getTime() < 24 * 60 * 60 * 1000) return null;
  if (onlyIfDue && connection.last_sync_attempt_at
    && Date.now() - new Date(connection.last_sync_attempt_at).getTime() < 6 * 60 * 60 * 1000) return null;
  if (connection.status !== 'connected') throw failure(409, 'This bank connection needs attention before it can sync');
  const plaidClient = getPlaidClient();
  const accessToken = decryptPlaidToken(connection.access_token_ciphertext);
  const changes = await fetchAllChanges(plaidClient, accessToken, connection.cursor);
  const config = await loadCategorization(client);
  const added = changes.added.map(plaidTransaction);
  const modified = changes.modified.map(plaidTransaction);
  const postedPendingIds = new Set([...added, ...modified].map(row => row.pendingTransactionId).filter(Boolean));

  for (const row of [...added, ...modified]) {
    if (row.pendingTransactionId) await reconcilePostedTransaction(client, row);
    const previousTransaction = (await client.query(`SELECT id FROM transactions
      WHERE plaid_transaction_id=$1 AND user_id=current_setting('app.user_id')::integer`,
    [row.plaidTransactionId])).rows[0];
    if (previousTransaction) {
      await client.query(`UPDATE transactions SET plaid_account_id=$1,date=$2,description=$3,
        amount=$4,direction=$5,is_pending=$6 WHERE id=$7`,
      [row.plaidAccountId, row.date, row.description, row.amount, row.direction, row.isPending, previousTransaction.id]);
      continue;
    }
    const existingReview = (await client.query(`SELECT id,status FROM transaction_import_reviews
      WHERE plaid_transaction_id=$1 AND user_id=current_setting('app.user_id')::integer`,
    [row.plaidTransactionId])).rows[0];
    if (existingReview && existingReview.status !== 'removed') {
      if (existingReview.status === 'pending') {
        await client.query(`UPDATE transaction_import_reviews SET date=$1,description=$2,amount=$3,
          direction=$4,plaid_account_id=$5,is_pending=$6 WHERE id=$7`,
        [row.date, row.description, row.amount, row.direction, row.plaidAccountId, row.isPending, existingReview.id]);
      }
      continue;
    }
    await importTransactions(client, [row], config, 'plaid');
  }

  for (const removed of changes.removed) {
    if (postedPendingIds.has(removed.transaction_id)) continue;
    const plaidOwned = (await client.query(`SELECT id FROM transactions
      WHERE plaid_transaction_id=$1 AND user_id=current_setting('app.user_id')::integer AND source='plaid'
      FOR UPDATE`, [removed.transaction_id])).rows.map(row => row.id);
    if (plaidOwned.length) {
      await client.query(`UPDATE transaction_import_reviews SET
        resolution_transaction_id=CASE WHEN resolution_transaction_id=ANY($1::integer[]) THEN NULL ELSE resolution_transaction_id END,
        matched_transaction_id=CASE WHEN matched_transaction_id=ANY($1::integer[]) THEN NULL ELSE matched_transaction_id END
        WHERE user_id=current_setting('app.user_id')::integer
          AND (resolution_transaction_id=ANY($1::integer[]) OR matched_transaction_id=ANY($1::integer[]))`,
      [plaidOwned]);
      await client.query(`DELETE FROM transactions WHERE id=ANY($1::integer[])
        AND user_id=current_setting('app.user_id')::integer`, [plaidOwned]);
    }
    await client.query(`UPDATE transactions SET plaid_transaction_id=NULL,plaid_account_id=NULL,is_pending=FALSE
      WHERE plaid_transaction_id=$1 AND user_id=current_setting('app.user_id')::integer AND source<>'plaid'`,
    [removed.transaction_id]);
    await client.query(`UPDATE transaction_import_reviews SET status='removed', resolved_at=NOW()
      WHERE plaid_transaction_id=$1 AND user_id=current_setting('app.user_id')::integer
        AND status IN ('pending','duplicate','imported')`,
    [removed.transaction_id]);
  }

  await refreshPlaidAccountBalances(client, connection.id, accessToken, plaidClient);
  await client.query(`UPDATE plaid_connections SET cursor=$2,last_sync_at=NOW(),
    last_sync_attempt_at=NOW(),last_error_code=NULL
    WHERE id=$1 AND user_id=current_setting('app.user_id')::integer`,
  [connection.id, changes.cursor || null]);
  return { added: added.length, modified: modified.length, removed: changes.removed.length };
}

async function syncAndRecordFailure(connectionId) {
  try {
    return await db.transaction(client => syncConnection(client, connectionId));
  } catch (error) {
    const code = plaidErrorCode(error);
    const storedCode = /^[A-Z0-9_]{1,100}$/.test(code || '') ? code : 'SYNC_FAILED';
    await db.run(`UPDATE plaid_connections SET last_error_code=$2,last_sync_attempt_at=NOW(),
      status=CASE WHEN $2 IN ('ITEM_LOGIN_REQUIRED','INVALID_ACCESS_TOKEN','ITEM_NOT_FOUND')
        THEN 'relink_required' ELSE status END
      WHERE id=$1`, [connectionId, storedCode]);
    throw error;
  }
}

export async function syncDuePlaidConnections(structuredLog) {
  const connections = await administrativeTransaction(async client => (await client.query(`SELECT id,user_id
    FROM plaid_connections WHERE status='connected'
      AND (last_sync_at IS NULL OR last_sync_at < NOW() - INTERVAL '24 hours')
      AND (last_sync_attempt_at IS NULL OR last_sync_attempt_at < NOW() - INTERVAL '6 hours')
    ORDER BY last_sync_at NULLS FIRST LIMIT 100`)).rows);
  for (const connection of connections) {
    try {
      await withUser(connection.user_id, () =>
        db.transaction(client => syncConnection(client, connection.id, true)));
    } catch (error) {
      structuredLog('warn', {
        event: 'plaid.scheduled_sync_failed',
        connectionId: connection.id,
        userId: connection.user_id,
        errorCode: plaidErrorCode(error) || 'SYNC_FAILED'
      });
    }
  }
}

plaidRouter.post('/link-token', async (req, res, next) => {
  try {
    const plaidClient = getPlaidClient();
    const userId = currentUserId();
    const request = {
      user: { client_user_id: String(userId) },
      client_name: 'MyFinanceApp',
      language: 'en',
      country_codes: ['US'],
      webhook: plaidWebhookUrl()
    };
    if (req.body?.connectionId !== undefined) {
      const connectionId = Number(req.body.connectionId);
      if (!Number.isSafeInteger(connectionId) || connectionId < 1) throw failure(400, 'Invalid connection ID');
      const row = await db.get('SELECT access_token_ciphertext FROM plaid_connections WHERE id=$1', [connectionId]);
      if (!row) throw failure(404, 'Connected bank account not found');
      request.access_token = decryptPlaidToken(row.access_token_ciphertext);
    } else {
      request.products = ['transactions'];
      request.transactions = { days_requested: 365 };
    }
    const response = await plaidClient.linkTokenCreate(request);
    res.json({ link_token: response.data.link_token, expiration: response.data.expiration });
  } catch (error) { next(error); }
});

plaidRouter.post('/exchange', async (req, res, next) => {
  try {
    const publicToken = req.body?.public_token;
    if (typeof publicToken !== 'string' || publicToken.length < 10 || publicToken.length > 2048) {
      throw failure(400, 'A valid Plaid public token is required');
    }
    const plaidClient = getPlaidClient();
    const exchanged = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
    const institutionName = typeof req.body?.institutionName === 'string'
      ? req.body.institutionName.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) : null;
    const connection = await db.transaction(async client => {
      const userId = currentUserId();
      const row = (await client.query(`INSERT INTO plaid_connections
        (item_id,access_token_ciphertext,institution_name,user_id,status)
        VALUES ($1,$2,$3,$4,'connected')
        ON CONFLICT (user_id,item_id) DO UPDATE SET
          access_token_ciphertext=EXCLUDED.access_token_ciphertext,
          institution_name=COALESCE(EXCLUDED.institution_name,plaid_connections.institution_name),
          status='connected',last_error_code=NULL
        RETURNING id`,
      [exchanged.data.item_id, encryptPlaidToken(exchanged.data.access_token), institutionName, userId])).rows[0];
      return row;
    });
    let sync = null;
    let syncWarning = null;
    try {
      sync = await syncAndRecordFailure(connection.id);
    } catch {
      syncWarning = 'Your bank is connected, but its first transaction sync is still pending. It will retry when Plaid reports updates.';
    }
    res.json({ success: true, connectionId: connection.id, sync, syncWarning });
  } catch (error) { next(error); }
});

plaidRouter.get('/connections', async (req, res, next) => {
  try {
    const rows = await db.all(`SELECT c.id,c.institution_name,c.status,c.last_sync_at,c.last_error_code,
        a.id AS account_record_id,a.name,a.official_name,a.mask,a.type,a.subtype,a.current_balance,
        a.available_balance,a.iso_currency_code,a.use_for_cashflow,a.balance_checked_at
      FROM plaid_connections c LEFT JOIN plaid_accounts a
        ON a.connection_id=c.id AND a.user_id=c.user_id
      WHERE c.user_id=$1 ORDER BY c.created_at,c.id,a.created_at,a.id`, [currentUserId()]);
    const connections = [];
    for (const row of rows) {
      let connection = connections.find(item => item.id === row.id);
      if (!connection) {
        connection = {
          id: row.id, institutionName: row.institution_name, status: row.status,
          lastSyncAt: row.last_sync_at, lastErrorCode: row.last_error_code, accounts: []
        };
        connections.push(connection);
      }
      if (row.account_record_id !== null) connection.accounts.push({
        id: row.account_record_id, name: row.name, officialName: row.official_name, mask: row.mask,
        type: row.type, subtype: row.subtype, currentBalance: row.current_balance,
        availableBalance: row.available_balance, currency: row.iso_currency_code,
        useForCashflow: row.use_for_cashflow, balanceCheckedAt: row.balance_checked_at
      });
    }
    res.json({ connections });
  } catch (error) { next(error); }
});

plaidRouter.post('/connections/:id/sync', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw failure(400, 'Invalid connection ID');
    const result = await syncAndRecordFailure(id);
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

plaidRouter.post('/connections/:id/update-link', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw failure(400, 'Invalid connection ID');
    const connection = await db.get(
      'SELECT access_token_ciphertext FROM plaid_connections WHERE id=$1', [id]
    );
    if (!connection) throw failure(404, 'Connected bank account not found');
    const response = await getPlaidClient().linkTokenCreate({
      user: { client_user_id: String(currentUserId()) },
      client_name: 'MyFinanceApp',
      language: 'en',
      country_codes: ['US'],
      access_token: decryptPlaidToken(connection.access_token_ciphertext)
    });
    res.json({ link_token: response.data.link_token, expiration: response.data.expiration });
  } catch (error) { next(error); }
});

plaidRouter.patch('/accounts/:id/cashflow', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const enabled = req.body?.enabled;
    if (!Number.isSafeInteger(id) || id < 1 || typeof enabled !== 'boolean') {
      throw failure(400, 'A valid account ID and enabled value are required');
    }
    const result = await db.run(`UPDATE plaid_accounts SET use_for_cashflow=$2
      WHERE id=$1 AND user_id=$3 AND type='depository' AND iso_currency_code='USD'`,
    [id, enabled, currentUserId()]);
    if (!result.rowCount) throw failure(404, 'Eligible connected cash account not found');
    res.json({ success: true });
  } catch (error) { next(error); }
});

plaidRouter.delete('/connections/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw failure(400, 'Invalid connection ID');
    const connection = await db.get('SELECT * FROM plaid_connections WHERE id=$1', [id]);
    if (!connection) throw failure(404, 'Connected bank account not found');
    await getPlaidClient().itemRemove({ access_token: decryptPlaidToken(connection.access_token_ciphertext) });
    await db.run('DELETE FROM plaid_connections WHERE id=$1 AND user_id=$2', [id, currentUserId()]);
    res.json({ success: true });
  } catch (error) { next(error); }
});

webhookRouter.post('/', async (req, res, next) => {
  try {
    const plaidClient = getPlaidClient();
    const valid = await verifyPlaidWebhook(req.rawBody, req.get('plaid-verification'), plaidClient);
    if (!valid) return res.status(401).json({ error: 'Invalid Plaid webhook signature' });
    const itemId = req.body?.item_id;
    if (typeof itemId !== 'string' || !itemId) return res.status(400).json({ error: 'Invalid Plaid webhook payload' });
    const connection = await administrativeTransaction(async client =>
      (await client.query(`SELECT id,user_id FROM plaid_connections
        WHERE item_id=$1 AND status='connected' LIMIT 1`, [itemId])).rows[0]);
    if (!connection) return res.json({ received: true });
    await withUser(connection.user_id, async () => {
      if (req.body.webhook_type === 'TRANSACTIONS'
        && ['SYNC_UPDATES_AVAILABLE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE'].includes(req.body.webhook_code)) {
        await syncAndRecordFailure(connection.id);
      } else if (req.body.webhook_type === 'ITEM' && req.body.webhook_code === 'ERROR') {
        const code = String(req.body.error?.error_code || 'ITEM_ERROR').slice(0, 100);
        await db.run(`UPDATE plaid_connections SET status='relink_required',last_error_code=$2
          WHERE id=$1`, [connection.id, code]);
      }
    });
    res.json({ received: true });
  } catch (error) { next(error); }
});

export { webhookRouter };
export default plaidRouter;
