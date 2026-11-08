import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import postgres from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { PlaidApi } from 'plaid';
import { migratePrivateSchema } from './schema.js';
import { withUser } from './tenant.js';
import { encryptPlaidToken } from './plaid.js';
import { plaidMortgageDetails, applyMortgageEvidence, ensurePlaidAccounts, refreshMortgageAccounts } from './mortgageSync.js';
import { parseStatementText } from './pdfParser.js';
import { statementPDF } from './test-fixtures/statements.js';
import mortgageRouter from '../routes/mortgage.js';
import plaidRouter from '../routes/plaid.js';
import accountsRouter from '../routes/accounts.js';
import importRouter from '../routes/import.js';
import { changeImports } from './importHistory.js';

const lines = [
  'PennyMac', 'Mortgage Statement', 'Loan Number: XXXX1234', 'Statement Date: 11/01/2026',
  'Outstanding Principal Balance: $185000.00', 'Interest Rate: 4.25%',
  'Original Loan Amount: $250000.00', 'Loan Term: 30 years',
  'Origination Date: 01/15/2018', 'Maturity Date: 02/01/2048',
  'First Payment Date: 03/01/2018', 'Monthly Escrow Payment: $450.00',
  'Principal and Interest: $1229.85'
];
const adapter = pg => ({
  async query(sql, params = []) {
    const result = params.length ? await pg.query(sql, params) : (await pg.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  }
});

test('mortgage statements read verified loan facts without fabricating payment transactions', () => {
  const result = parseStatementText(lines.join('\n'));
  assert.equal(result.statement.type, 'mortgage');
  assert.equal(result.statement.last4, '1234');
  assert.equal(result.statement.institution, 'PennyMac');
  assert.deepEqual(result.statement.mortgage, {
    balance: 185000, apr: 4.25, original_amount: 250000, term_months: 360,
    origination_date: '2018-01-15', maturity_date: '2048-02-01',
    first_payment_month: '2018-03', first_payment_estimated: false, escrow_payment: 450, min_payment: 1229.85
  });
  assert.equal(result.reconciliation.status, 'metadata-only');
  assert.deepEqual(result.transactions, []);
  assert.throws(() => parseStatementText(lines.concat('Interest Rate: 5.25%').join('\n')), /Conflicting mortgage interest/);
  assert.throws(() => parseStatementText(lines.filter(line => !line.includes('Outstanding Principal')).join('\n')), /principal balance are required/);
  assert.throws(() => parseStatementText(lines.map(line => line.replace('11/01/2026', '02/30/2026')).join('\n')), /statement date/);
});

test('Plaid mortgage mapping never treats the escrow reserve as a monthly payment', () => {
  const details = plaidMortgageDetails({ loan_term: '30 years', maturity_date: '2048-02-01',
    origination_date: '2018-01-15', origination_principal_amount: 250000,
    interest_rate: { percentage: 4.25, type: 'fixed' }, escrow_balance: 5200, next_monthly_payment: 1700 },
  { balances: { current: 185000 } });
  assert.equal(details.term_months, 360);
  assert.equal(details.first_payment_month, '2018-03');
  assert.equal(details.apr, 4.25);
  assert.equal(details.escrow_payment, undefined);
  assert.equal(details.min_payment, undefined);
  assert.equal(details.escrow_balance, 5200);
});

test('read-only support views never run account or mortgage backfill writes', async () => {
  await withUser(1, async () => {
    const client = { query: () => assert.fail('read-only views cannot run backfill queries') };
    await ensurePlaidAccounts(client);
    await refreshMortgageAccounts(client);
  }, { readOnly: true });
});

test('mortgage sync, account listing, explicit linking, PDF updates and recovery stay in sync', async t => {
  const pg = new PGlite(), client = adapter(pg);
  const keys = ['PLAID_ENVIRONMENT', 'PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_TOKEN_ENCRYPTION_KEY'];
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let server;
  try {
    process.env.PLAID_ENVIRONMENT = 'sandbox';
    process.env.PLAID_CLIENT_ID = 'test-only-client';
    process.env.PLAID_SECRET = 'test-only-secret';
    process.env.PLAID_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    await pg.transaction(tx => migratePrivateSchema(adapter(tx)));
    await client.query(`INSERT INTO users(id,name) VALUES(2,'Other fixture');
      INSERT INTO credit_cards(id,user_id,name,debt_type,balance,apr,original_amount,term_months,first_payment_month,escrow_payment,included)
      VALUES(1,1,'Manual home','mortgage',190000,4,250000,360,'2018-03',400,FALSE),
        (2,2,'Other home','mortgage',99999,8,150000,360,'2020-01',200,FALSE);`);
    await client.query(`INSERT INTO plaid_connections(user_id,item_id,access_token_ciphertext,institution_name)
      VALUES(1,'mortgage-item',$1,'PennyMac')`, [encryptPlaidToken('access-sandbox-fixture')]);
    t.mock.method(postgres.Pool.prototype, 'connect', async () => ({ ...client, release() {} }));
    t.mock.method(PlaidApi.prototype, 'accountsGet', async () => ({ data: { accounts: [{
      account_id: 'mortgage-account', name: 'FHA Residential', mask: '1234', type: 'loan', subtype: 'mortgage',
      balances: { current: 186000, iso_currency_code: 'USD' }
    }] } }));
    let liabilityFailure = false;
    t.mock.method(PlaidApi.prototype, 'liabilitiesGet', async () => {
      if (liabilityFailure) throw { response: { data: { error_code: 'PRODUCT_NOT_ENABLED' } } };
      return { data: { liabilities: { mortgage: [{
        account_id: 'mortgage-account', loan_term: '30 years', maturity_date: '2048-02-01',
        origination_date: '2018-01-15', origination_principal_amount: 250000,
        interest_rate: { percentage: 4.125, type: 'fixed' }, escrow_balance: 5200
      }] } } };
    });
    t.mock.method(PlaidApi.prototype, 'transactionsSync', async () => {
      throw { response: { data: { error_code: 'PRODUCT_NOT_SUPPORTED' } } };
    });
    t.mock.method(PlaidApi.prototype, 'linkTokenCreate', async request => {
      if (request.access_token) assert.deepEqual(request.additional_consented_products, ['liabilities']);
      else assert.deepEqual(request.optional_products, ['liabilities']);
      return { data: { link_token: 'fixture-link' } };
    });
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use((req, res, next) => { req.user = { id: 1 }; withUser(1, next); });
    app.use('/mortgage', mortgageRouter);
    app.use('/plaid', plaidRouter);
    app.use('/accounts', accountsRouter);
    app.use('/import', importRouter);
    app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (path, body) => {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data;
    };
    const sync = await call('/plaid/connections/1/sync', {});
    assert.equal(sync.transactionErrorCode, 'PRODUCT_NOT_SUPPORTED');
    assert.match(sync.syncWarning, /checked separately/);
    const accounts = (await call('/accounts')).accounts;
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].kind, 'loan');
    assert.equal(accounts[0].plaid.reportedBalance, 186000);
    const accountId = accounts[0].id;
    assert.equal((await call('/accounts/import-options')).accounts[0].id, accountId);
    const beforeLink = await call('/mortgage');
    assert.equal(beforeLink.sources[0].linked, false);
    assert.equal(beforeLink.mortgages[0].apr, 4, 'manual mortgage is untouched until the user confirms identity');
    await call('/mortgage/link', { accountId, debtId: 1 });
    const linked = (await call('/mortgage')).mortgages[0];
    assert.equal(linked.apr, 4.125);
    assert.equal(linked.balance, 186000);
    assert.equal(linked.escrow_payment, 400);
    assert.equal(linked.first_payment_month, '2018-03');
    assert.equal(linked.origination_date, '2018-01-15');
    assert.equal(linked.maturity_date, '2048-02-01');
    assert.equal(linked.included, false);
    assert.ok(linked.simulation);
    assert.equal((await call('/mortgage')).mortgages.length, 1);
    const other = (await client.query('SELECT balance,apr FROM credit_cards WHERE user_id=2')).rows[0];
    assert.equal(Number(other.balance), 99999);
    await call('/plaid/connections/1/update-link', {});
    liabilityFailure = true;
    const missing = await call('/plaid/connections/1/sync', {});
    assert.equal(missing.mortgageWarning, 'PRODUCT_NOT_ENABLED');
    assert.equal((await call('/mortgage')).sources[0].errorCode, 'PRODUCT_NOT_ENABLED');
    assert.equal((await call('/mortgage')).mortgages[0].apr, 4.125);

    // A future-dated fixture keeps this test independent of the machine's current date.
    const pdfBody = { pdfBase64: statementPDF(lines.map(line => line.replace('11/01/2026', '11/01/2090'))).toString('base64'), accountId };
    const imported = await call('/import/import-pdf', pdfBody);
    assert.equal(imported.imported, 0);
    assert.equal(imported.mortgage.id, 1);
    assert.equal((await call('/mortgage')).mortgages[0].apr, 4.25);
    assert.equal((await call('/accounts')).accounts[0].balance, 185000);
    const recover = (batchId, action) => withUser(1, () => pg.transaction(async tx => {
      const tenant = adapter(tx);
      await tenant.query("SELECT set_config('app.user_id','1',true)");
      return changeImports(tenant, [batchId], action);
    }));
    await recover(imported.batchId, 'undo');
    assert.equal((await call('/mortgage')).mortgages[0].apr, 4.125);
    await recover(imported.batchId, 'restore');
    assert.equal((await call('/mortgage')).mortgages[0].apr, 4.25);
    const repeated = await call('/import/import-pdf', pdfBody);
    assert.equal((await call('/mortgage')).mortgages.length, 1);
    await client.query('UPDATE credit_cards SET apr=5 WHERE id=1');
    await assert.rejects(recover(repeated.batchId, 'undo'), /Mortgage details changed/);
    assert.equal((await call('/mortgage')).mortgages[0].apr, 5, 'GET does not replay stale evidence over manual edits');
    const partial = await withUser(1, () => pg.transaction(async tx => {
      const tenant = adapter(tx);
      await tenant.query("SELECT set_config('app.user_id','1',true)");
      const account = (await tenant.query('SELECT * FROM accounts WHERE id=$1', [accountId])).rows[0];
      return applyMortgageEvidence(tenant, account, { apr: null, balance: 1 }, 'statement', '2000-01-01');
    }));
    assert.equal(partial.id, 1);
    assert.equal((await call('/mortgage')).mortgages[0].balance, 185000, 'older evidence cannot replace newer facts');
    await client.query("SELECT setval(pg_get_serial_sequence('credit_cards','id'),(SELECT MAX(id) FROM credit_cards),true)");
    await withUser(1, () => pg.transaction(async tx => {
      const tenant = adapter(tx);
      await tenant.query("SELECT set_config('app.user_id','1',true)");
      const account = (await tenant.query("INSERT INTO accounts(name,kind) VALUES('Separate mortgage','loan') RETURNING *")).rows[0];
      await assert.rejects(applyMortgageEvidence(tenant, account, { balance: 0 }, 'statement', '2090-12-01', 2), /not available/);
      const created = await applyMortgageEvidence(tenant, account, {
        balance: 0, original_amount: 100000, apr: null, term_months: 360, first_payment_month: '2020-01'
      }, 'statement', '2090-12-01');
      const debt = (await tenant.query('SELECT * FROM credit_cards WHERE id=$1', [created.id])).rows[0];
      assert.equal(debt.apr, null, 'an unavailable rate is not represented as a zero-percent loan');
      assert.equal(Number(debt.balance), 0, 'a reported paid-off balance stays zero');
    }));
    const newMortgage = (await call('/mortgage')).mortgages.find(m => m.name === 'Separate mortgage');
    assert.equal(newMortgage.simulation, null, 'missing APR requires completion before a schedule is shown');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
    await pg.close();
  }
});
