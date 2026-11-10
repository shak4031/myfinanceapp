import express from 'express';
import { administrativeTransaction } from '../db.js';
import Database from '../db.js';
import { ensurePlaidAccounts, refreshMortgageAccounts, plaidMortgageDetails } from '../utils/mortgageSync.js';
import { reconcileTransfers } from '../utils/transfers.js';
import { withUser, currentUserId } from '../utils/tenant.js';
import { structuredLog } from '../utils/audit.js';
import { plaidFailureDetails, plaidRecovery } from '../utils/plaidHealth.js';
import { classify, failure, loadCategorization } from '../utils/categorization.js';
import { importTransactions, plaidCategoryValue, refreshImportReviewCandidates, releaseHeldPlaidReviews } from '../utils/transactionImport.js';
import {
  decryptPlaidToken, encryptPlaidToken, getPlaidClient, plaidErrorCode, plaidTransaction, verifyPlaidWebhook,
  assertPlaidTokenEnvironment, plaidTokenEnvironment
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
    const requestIds = new Map();
    try {
      let response;
      do {
        response = await plaidClient.transactionsSync({
          access_token: accessToken,
          options: { include_original_description: true },
          ...(cursor ? { cursor } : {})
        });
        added.push(...response.data.added);
        modified.push(...response.data.modified);
        for (const row of [...response.data.added, ...response.data.modified]) {
          requestIds.set(row.transaction_id, response.data.request_id);
        }
        removed.push(...response.data.removed);
        cursor = response.data.next_cursor;
      } while (response.data.has_more);
      return { added, modified, removed, cursor, requestIds };
    } catch (error) {
      if (plaidErrorCode(error) !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' || attempt === 2) throw error;
    }
  }
  throw new Error('Plaid transaction pagination could not be completed');
}

async function refreshPlaidAccountBalances(client, connectionId, accessToken, plaidClient) {
  const accounts = (await plaidClient.accountsGet({ access_token: accessToken })).data.accounts;
  await saveAccounts(client, connectionId, accounts);
  await ensurePlaidAccounts(client);
  let warning = null;
  if (accounts.some(account => account.subtype === 'mortgage')) {
    try {
      const response = await plaidClient.liabilitiesGet({ access_token: accessToken });
      for (const mortgage of response.data.liabilities?.mortgage || []) {
        const account = accounts.find(item => item.account_id === mortgage.account_id);
        if (!account) throw new Error('Plaid returned mortgage details for an unknown account');
        await client.query(`UPDATE plaid_accounts SET mortgage_details=$1::jsonb
          WHERE account_id=$2 AND connection_id=$3 AND user_id=$4`,
        [JSON.stringify(plaidMortgageDetails(mortgage, account)), account.account_id, connectionId, currentUserId()]);
      }
      if (!response.data.liabilities?.mortgage?.length) warning = 'MORTGAGE_DATA_UNAVAILABLE';
    } catch (error) {
      const code = plaidErrorCode(error);
      if (!code) throw error;
      warning = code;
    }
    await client.query('UPDATE plaid_connections SET liabilities_error_code=$2 WHERE id=$1 AND user_id=$3',
      [connectionId, warning, currentUserId()]);
  }
  await refreshMortgageAccounts(client, !warning, connectionId);
  return warning;
}

async function updateSyncedTransaction(client, previous, row, config) {
  const directionChanged = previous.direction !== row.direction;
  const category = directionChanged && !previous.category_corrected
    ? classify(row, config.compiled, config.names).category : previous.category;
  const plaidCategory = plaidCategoryValue(row.plaidCategory);
  await client.query(`UPDATE transactions SET plaid_transaction_id=$1,plaid_account_id=$2,
      date=$3,description=CASE WHEN source='plaid' THEN $4 ELSE description END,
      amount=$5,direction=$6,is_pending=$7,category=$8,${plaidCategory ? '\n      plaid_category=$10,' : ''}
      income_role=CASE WHEN $6='DEBIT' THEN NULL ELSE income_role END,
      pay_mode=CASE WHEN $6='CREDIT' THEN NULL ELSE pay_mode END,
      transfer_checked=CASE WHEN direction IS DISTINCT FROM $6 THEN FALSE ELSE transfer_checked END
    WHERE id=$9 AND user_id=current_setting('app.user_id')::integer`,
  [row.plaidTransactionId, row.plaidAccountId, row.date, row.description, row.amount,
    row.direction, row.isPending, category, previous.id, ...(plaidCategory ? [plaidCategory] : [])]);
}

async function reconcilePostedTransaction(client, posted, config) {
  if (!posted.pendingTransactionId) return false;
  const pending = (await client.query(`SELECT id,direction,category,category_corrected FROM transactions
    WHERE plaid_transaction_id=$1 AND user_id=current_setting('app.user_id')::integer
    FOR UPDATE`, [posted.pendingTransactionId])).rows[0];
  if (pending) {
    await updateSyncedTransaction(client, pending, posted, config);
    return true;
  }
  const review = (await client.query(`SELECT id FROM transaction_import_reviews
    WHERE plaid_transaction_id=$1 AND user_id=current_setting('app.user_id')::integer
      AND status IN ('pending','duplicate') FOR UPDATE`, [posted.pendingTransactionId])).rows[0];
  if (review) {
    const updated = (await client.query(`UPDATE transaction_import_reviews SET plaid_transaction_id=$1, plaid_account_id=$2,
        date=$3,description=$4,amount=$5,direction=$6,is_pending=FALSE
      WHERE id=$7 RETURNING *`, [posted.plaidTransactionId, posted.plaidAccountId, posted.date,
      posted.description, posted.amount, posted.direction, review.id])).rows[0];
    if (updated.status === 'pending') await refreshImportReviewCandidates(client, updated);
    return true;
  }
  return false;
}

export async function syncConnection(client, connectionId, onlyIfDue = false, onStage = () => {}) {
  await client.query('SELECT pg_advisory_xact_lock($1::integer,193647)', [currentUserId()]);
  const connection = (await client.query(`SELECT * FROM plaid_connections
    WHERE id=$1 AND user_id=current_setting('app.user_id')::integer
    FOR UPDATE`, [connectionId])).rows[0];
  if (!connection) throw failure(404, 'Connected bank account not found');
  if (onlyIfDue && connection.last_sync_at
    && Date.now() - new Date(connection.last_sync_at).getTime() < 24 * 60 * 60 * 1000) return null;
  if (onlyIfDue && connection.last_sync_attempt_at
    && Date.now() - new Date(connection.last_sync_attempt_at).getTime() < 6 * 60 * 60 * 1000) return null;
  if (connection.status !== 'connected') throw failure(409, 'This bank connection needs attention before it can sync');
  onStage('configuration');
  const plaidClient = getPlaidClient();
  const accessToken = decryptPlaidToken(connection.access_token_ciphertext);
  assertPlaidTokenEnvironment(accessToken);
  onStage('account_balances');
  const mortgageWarning = await refreshPlaidAccountBalances(client, connection.id, accessToken, plaidClient);
  let changes;
  try {
    onStage('transactions_fetch');
    changes = await fetchAllChanges(plaidClient, accessToken, connection.cursor);
  } catch (error) {
    const code = plaidErrorCode(error);
    if (!code) throw error;
    await client.query(`UPDATE plaid_connections SET last_error_code=$2,last_sync_attempt_at=NOW(),
      status=CASE WHEN $2 IN ('ITEM_LOGIN_REQUIRED','INVALID_ACCESS_TOKEN','ITEM_NOT_FOUND') THEN 'relink_required' ELSE status END
      WHERE id=$1 AND user_id=$3`, [connection.id, code, currentUserId()]);
    return { added: 0, modified: 0, removed: 0, imported: 0, mortgageWarning, transactionErrorCode: code,
      failureDetails: plaidFailureDetails(error),
      syncWarning: `Accounts were checked, but transactions could not sync (${code}). Mortgage details ${mortgageWarning ? `are unavailable (${mortgageWarning}); import a statement or reconnect with mortgage access` : 'were checked separately'}.` };
  }
  onStage('transactions_validate');
  const normalize = raw => {
    try { return plaidTransaction(raw); } catch (error) {
      error.providerRequestId = changes.requestIds.get(raw?.transaction_id);
      throw error;
    }
  };
  const normalizedAdded = changes.added.map(normalize);
  const normalizedModified = changes.modified.map(normalize);
  const zeroAmount = [...normalizedAdded, ...normalizedModified].filter(row => row.amount === 0);
  const added = normalizedAdded.filter(row => row.amount > 0);
  const modified = normalizedModified.filter(row => row.amount > 0);
  onStage('transactions_apply');
  const config = await loadCategorization(client);
  const postedPendingIds = new Set([...added, ...modified].map(row => row.pendingTransactionId).filter(Boolean));
  const incoming = [];

  for (const row of [...added, ...modified]) {
    if (row.pendingTransactionId) await reconcilePostedTransaction(client, row, config);
    const previousTransaction = (await client.query(`SELECT id,direction,category,category_corrected FROM transactions
      WHERE plaid_transaction_id=$1 AND user_id=current_setting('app.user_id')::integer`,
    [row.plaidTransactionId])).rows[0];
    if (previousTransaction) {
      await updateSyncedTransaction(client, previousTransaction, row, config);
      continue;
    }
    const existingReview = (await client.query(`SELECT id,status FROM transaction_import_reviews
      WHERE plaid_transaction_id=$1 AND user_id=current_setting('app.user_id')::integer`,
    [row.plaidTransactionId])).rows[0];
    if (existingReview && existingReview.status !== 'removed') {
      if (existingReview.status === 'pending') {
        const updated = (await client.query(`UPDATE transaction_import_reviews SET date=$1,description=$2,amount=$3,
          direction=$4,plaid_account_id=$5,is_pending=$6 WHERE id=$7 RETURNING *`,
        [row.date, row.description, row.amount, row.direction, row.plaidAccountId, row.isPending, existingReview.id])).rows[0];
        await refreshImportReviewCandidates(client, updated);
      }
      continue;
    }
    incoming.push(row);
  }
  const imported = await importTransactions(client, incoming, config, 'plaid');

  // Zero-dollar authorizations have no ledger value. A modified/replaced record
  // must still retire any earlier nonzero version rather than leave stale money.
  const removals = new Set([...changes.removed.map(row => row.transaction_id),
    ...zeroAmount.flatMap(row => [row.plaidTransactionId, row.pendingTransactionId].filter(Boolean))]);
  for (const transactionId of removals) {
    const removed = { transaction_id: transactionId };
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
        AND status IN ('pending','duplicate','imported','separate')`,
    [removed.transaction_id]);
  }

  const released = await releaseHeldPlaidReviews(client, connection.id, config);
  const flagged = (await client.query(`SELECT * FROM transaction_import_reviews
    WHERE user_id=current_setting('app.user_id')::integer AND status='pending'
      AND resolution_transaction_id IS NOT NULL AND plaid_account_id IN
        (SELECT account_id FROM plaid_accounts WHERE connection_id=$1 AND user_id=current_setting('app.user_id')::integer)`,
  [connection.id])).rows;
  for (const review of flagged) {
    const current = (await client.query(`SELECT date,description,amount,direction,is_pending FROM transactions
      WHERE id=$1 AND user_id=current_setting('app.user_id')::integer`, [review.resolution_transaction_id])).rows[0];
    if (!current) continue;
    await client.query(`UPDATE transaction_import_reviews SET date=$2,description=$3,amount=$4,direction=$5,is_pending=$6
      WHERE id=$1`, [review.id, current.date, current.description, current.amount, current.direction, current.is_pending]);
    await refreshImportReviewCandidates(client, { ...review, ...current });
    await client.query(`UPDATE transaction_import_reviews SET status='imported',resolved_at=NOW()
      WHERE id=$1 AND cardinality(candidate_transaction_ids)=0`, [review.id]);
  }
  await client.query(`UPDATE plaid_connections SET cursor=$2,last_sync_at=NOW(),
    last_sync_attempt_at=NOW(),last_error_code=NULL
    WHERE id=$1 AND user_id=current_setting('app.user_id')::integer`,
  [connection.id, changes.cursor || null]);
  const reviewCounts = (await client.query(`SELECT
    COUNT(*) FILTER(WHERE resolution_transaction_id IS NULL)::integer AS held,
    COUNT(*) FILTER(WHERE resolution_transaction_id IS NOT NULL)::integer AS flagged
    FROM transaction_import_reviews WHERE user_id=current_setting('app.user_id')::integer AND status='pending'`)).rows[0];
  await client.query(`UPDATE transactions t SET account_id=a.linked_account_id
    FROM plaid_accounts a WHERE t.plaid_account_id=a.account_id AND t.user_id=a.user_id
      AND a.connection_id=$1 AND a.user_id=$2 AND t.account_id IS NULL AND a.linked_account_id IS NOT NULL`,
  [connection.id, currentUserId()]);
  await reconcileTransfers(client, currentUserId());
  return { added: changes.added.length, modified: changes.modified.length, removed: changes.removed.length,
    ignoredZeroAmount: zeroAmount.length,
    imported: imported.imported, autoMatched: imported.autoMatched || 0, released,
    pendingReviews: reviewCounts.held, flaggedReviews: reviewCounts.flagged, mortgageWarning,
    ...(mortgageWarning ? { syncWarning: `Transactions synced, but mortgage details are unavailable (${mortgageWarning}). Import a mortgage statement or reconnect with mortgage access.` } : {}) };
}

async function syncAndRecordFailure(connectionId, onlyIfDue = false, trigger = 'manual') {
  const started = Date.now();
  let operation = 'connection_lookup';
  const context = { connectionId, userId: currentUserId(), trigger };
  structuredLog('info', { event: 'plaid.sync_started', ...context, operation,
    message: 'Bank sync requested. Waiting for the connection lock, then checking balances and transaction changes.' });
  try {
    const result = await db.transaction(client => syncConnection(client, connectionId, onlyIfDue, stage => {
      operation = stage;
    }));
    if (result) {
      const code = result.transactionErrorCode || result.mortgageWarning;
      structuredLog(code ? 'warn' : 'info', {
        event: result.transactionErrorCode ? 'plaid.sync_failed' : code ? 'plaid.sync_partial' : 'plaid.sync_completed',
        ...context, operation, durationMs: Date.now() - started,
        ...(result.failureDetails || {}), errorCode: code || undefined,
        added: result.added, modified: result.modified, removed: result.removed, imported: result.imported,
        pendingReviews: result.pendingReviews, flaggedReviews: result.flaggedReviews, released: result.released,
        ignoredZeroAmount: result.ignoredZeroAmount,
        message: result.transactionErrorCode ? `Transactions could not sync (${code}). ${plaidRecovery(code)}`
          : code ? `Transactions synced; mortgage details unavailable (${code}). ${plaidRecovery(code)}`
            : `Transaction check completed: ${result.added} added, ${result.modified} modified, ${result.removed} removed; ${result.imported} imported, ${result.pendingReviews || 0} held for review; ${result.ignoredZeroAmount || 0} zero-dollar records omitted from the ledger.`
      });
    }
    return result;
  } catch (error) {
    const details = plaidFailureDetails(error);
    const storedCode = details.errorCode;
    structuredLog('error', { event: 'plaid.sync_failed', ...context, ...details,
      operation, durationMs: Date.now() - started,
      message: `Sync failed during ${operation} (${storedCode}). ${plaidRecovery(storedCode)}` });
    if (error.status === 404) throw error;
    await db.run(`UPDATE plaid_connections SET last_error_code=$2,last_sync_attempt_at=NOW(),
      status=CASE WHEN $2 IN ('ITEM_LOGIN_REQUIRED','INVALID_ACCESS_TOKEN','ITEM_NOT_FOUND','PLAID_ENVIRONMENT_MISMATCH')
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
      const result = await withUser(connection.user_id, () => syncAndRecordFailure(connection.id, true, 'scheduled'));
      if (result?.transactionErrorCode || result?.mortgageWarning) structuredLog('warn', {
        event: 'plaid.scheduled_sync_failed', connectionId: connection.id, userId: connection.user_id,
        errorCode: result.transactionErrorCode || result.mortgageWarning,
        message: 'Scheduled bank check needs attention. See the connection sync event for the failed stage and recovery steps.'
      });
    } catch (error) {
      structuredLog('warn', {
        event: 'plaid.scheduled_sync_failed',
        connectionId: connection.id,
        userId: connection.user_id,
        errorCode: plaidErrorCode(error) || 'SYNC_FAILED',
        message: 'Scheduled bank check failed. See the connection sync event for the failed stage and recovery steps.'
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
      assertPlaidTokenEnvironment(request.access_token);
      request.additional_consented_products = ['liabilities'];
    } else {
      request.products = ['transactions'];
      request.optional_products = ['liabilities'];
      request.transactions = { days_requested: 365 };
    }
    const response = await plaidClient.linkTokenCreate(request);
    res.json({ link_token: response.data.link_token, expiration: response.data.expiration });
  } catch (error) {
    if (error?.response) {
      const details = plaidFailureDetails(error);
      structuredLog('error', {
        event: 'plaid.link_token_failed',
        requestId: req.id,
        userId: currentUserId(),
        operation: 'link_token_create',
        ...details,
        message: 'Plaid rejected a Link token request.'
      });
      return next(Object.assign(
        new Error('Plaid could not prepare the secure bank connection. Try again; contact support if this continues.'),
        { status: 502, code: details.errorCode, providerRequestId: details.providerRequestId }
      ));
    }
    next(error);
  }
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
      sync = await syncAndRecordFailure(connection.id, false, 'initial');
      syncWarning = sync?.syncWarning || null;
    } catch {
      syncWarning = 'Your bank is connected, but its first transaction sync is still pending. It will retry when Plaid reports updates.';
    }
    res.json({ success: true, connectionId: connection.id, sync, syncWarning });
  } catch (error) { next(error); }
});

plaidRouter.get('/connections', async (req, res, next) => {
  try {
    const rows = await db.all(`SELECT c.id,c.institution_name,c.status,c.last_sync_at,c.last_sync_attempt_at,c.last_error_code,c.liabilities_error_code,
        (SELECT MAX(t.date) FROM transactions t WHERE t.user_id=c.user_id AND t.plaid_account_id=a.account_id
          AND t.plaid_transaction_id IS NOT NULL) AS latest_transaction_date,
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
          lastSyncAt: row.last_sync_at, lastAttemptAt: row.last_sync_attempt_at, lastErrorCode: row.last_error_code,
          mortgageErrorCode: row.liabilities_error_code, accounts: []
        };
        connections.push(connection);
      }
      if (row.account_record_id !== null) connection.accounts.push({
        id: row.account_record_id, name: row.name, officialName: row.official_name, mask: row.mask,
        type: row.type, subtype: row.subtype, currentBalance: row.current_balance,
        availableBalance: row.available_balance, currency: row.iso_currency_code,
        useForCashflow: row.use_for_cashflow, balanceCheckedAt: row.balance_checked_at,
        latestTransactionDate: row.latest_transaction_date
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
    res.json({ success: !result?.transactionErrorCode, ...result });
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
    const accessToken = decryptPlaidToken(connection.access_token_ciphertext);
    assertPlaidTokenEnvironment(accessToken);
    const response = await getPlaidClient().linkTokenCreate({
      user: { client_user_id: String(currentUserId()) },
      client_name: 'MyFinanceApp',
      language: 'en',
      country_codes: ['US'],
      additional_consented_products: ['liabilities'],
      access_token: accessToken
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
    const accessToken = decryptPlaidToken(connection.access_token_ciphertext);
    const tokenEnvironment = plaidTokenEnvironment(accessToken);
    const wrongEnvironment = tokenEnvironment && tokenEnvironment !== String(process.env.PLAID_ENVIRONMENT || 'sandbox').toLowerCase();
    if (!wrongEnvironment) await getPlaidClient().itemRemove({ access_token: accessToken });
    await db.run('DELETE FROM plaid_connections WHERE id=$1 AND user_id=$2', [id, currentUserId()]);
    res.json({ success: true, remoteRevoked: !wrongEnvironment,
      message: wrongEnvironment ? 'Old-environment connection removed locally; saved transactions were kept. The remote item was not revoked because it belongs to a different Plaid environment. Manage it in that environment separately.' : 'Bank disconnected. Saved transactions were kept.' });
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
      const webhookCode = /^[A-Z_]{1,100}$/.test(req.body.webhook_code || '') ? req.body.webhook_code : 'UNKNOWN';
      await db.run('UPDATE plaid_connections SET last_webhook_at=NOW(),last_webhook_code=$2 WHERE id=$1', [connection.id, webhookCode]);
      structuredLog('info', { event: 'plaid.webhook_received', userId: connection.user_id, connectionId: connection.id,
        webhookCode, message: `Verified Plaid webhook received (${webhookCode}).` });
      if ((req.body.webhook_type === 'TRANSACTIONS'
        && ['SYNC_UPDATES_AVAILABLE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE'].includes(req.body.webhook_code))
        || (req.body.webhook_type === 'LIABILITIES' && req.body.webhook_code === 'DEFAULT_UPDATE')) {
        await syncAndRecordFailure(connection.id, false, 'webhook');
      } else if (req.body.webhook_type === 'ITEM' && req.body.webhook_code === 'ERROR') {
        const code = String(req.body.error?.error_code || 'ITEM_ERROR').slice(0, 100);
        await db.run(`UPDATE plaid_connections SET status='relink_required',last_error_code=$2
          WHERE id=$1`, [connection.id, code]);
        structuredLog('warn', { event: 'plaid.item_error', userId: connection.user_id, connectionId: connection.id,
          errorCode: code, message: `Plaid reported a bank connection error. ${plaidRecovery(code)}` });
      }
    });
    res.json({ received: true });
  } catch (error) { next(error); }
});

export { webhookRouter };
export default plaidRouter;
