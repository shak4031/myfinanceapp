import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { decryptPlaidToken, encryptPlaidToken, plaidTransaction, verifyPlaidWebhook, assertPlaidTokenEnvironment, plaidTokenEnvironment } from './plaid.js';
import { isIncomeTransaction, incomeSources } from './income.js';
import { classify } from './categorization.js';
import { validateImportedTransaction } from './transactionImport.js';

test('Plaid amounts have consistent directions across banks and account types, regardless of wording', () => {
  const cases = [
    ['PENNYMAC MORTGAGE', 2325.69, 'DEBIT'],
    ['STATE FARM INSURANCE', 574.25, 'DEBIT'],
    ['HYUNDAI LEASE', 443, 'DEBIT'],
    ['SANTANDER AUTO PAYMENT', 513, 'DEBIT'],
    ['AT&T AUTOPAY', 80, 'DEBIT'],
    ['VISA PURCHASE', 37.15, 'DEBIT'],
    ['WELLS FARGO BANK PAYROLL', -2623.89, 'CREDIT'],
    ['CHASE DIRECT DEPOSIT', -3000, 'CREDIT'],
    ['AMAZON REFUND', -37.15, 'CREDIT'],
    ['CREDIT CARD PAYMENT THANK YOU', -120, 'CREDIT'],
    ['TRANSFER FROM SAVINGS', -500, 'CREDIT'],
    ['DEBIT REVERSAL REFUND', -10, 'CREDIT'],
    ['PAYROLL ADJUSTMENT', 25, 'DEBIT']
  ];
  for (const [name, amount, direction] of cases) {
    const raw = { transaction_id: name, account_id: 'account-1', date: '2026-10-15', name, amount, pending: false };
    const original = { ...raw };
    const tx = validateImportedTransaction(plaidTransaction(raw));
    assert.equal(tx.direction, direction, name);
    assert.equal(tx.amount, Math.abs(amount), name);
    assert.deepEqual(raw, original, 'normalization does not mutate the provider record');
    tx.is_fixed = true;
    tx.category = classify(tx, [], new Set(['Salary', 'Other'])).category;
    assert.equal(isIncomeTransaction(tx), /PAYROLL|DIRECT DEPOSIT/.test(name) && direction === 'CREDIT', name);
    if (direction === 'DEBIT') {
      assert.deepEqual(incomeSources([tx], new Date(2026, 9, 20)), [], 'bills never appear in income review');
    }
  }
});

test('Plaid environment mismatch is detected locally without exposing access tokens', () => {
  const previous = process.env.PLAID_ENVIRONMENT;
  try {
    process.env.PLAID_ENVIRONMENT = 'production';
    assert.equal(plaidTokenEnvironment('access-sandbox-private'), 'sandbox');
    assert.doesNotThrow(() => assertPlaidTokenEnvironment('access-production-private'));
    assert.throws(() => assertPlaidTokenEnvironment('access-sandbox-private'), error => {
      assert.equal(error.code, 'PLAID_ENVIRONMENT_MISMATCH');
      assert.equal(error.status, 409);
      assert.equal(error.message.includes('private'), false);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.PLAID_ENVIRONMENT; else process.env.PLAID_ENVIRONMENT = previous;
  }
});
test('Plaid normalization preserves bank wording and pending-to-posted identifiers', () => {
  const tx = plaidTransaction({
    transaction_id: 'posted-1', account_id: 'checking-1', date: '2026-10-15',
    merchant_name: 'Wells Fargo', name: 'WELLS FARGO BANK PAYROLL', amount: -2623.89,
    pending: false, pending_transaction_id: 'pending-1'
  });
  assert.deepEqual(tx, {
    date: '2026-10-15', description: 'WELLS FARGO BANK PAYROLL', amount: 2623.89, direction: 'CREDIT',
    balance: null, plaidTransactionId: 'posted-1', plaidAccountId: 'checking-1',
    isPending: false, pendingTransactionId: 'pending-1'
  });
  assert.equal(plaidTransaction({
    transaction_id: 'pending-2', account_id: 'card-1', date: '2026-10-15', merchant_name: 'Market', amount: 12.50, pending: true
  }).isPending, true);
  assert.equal(plaidTransaction({
    transaction_id: 'tx-3', account_id: 'card-1', date: '2026-10-15', merchant_name: 'Market', amount: 12.50
  }).description, 'Market');
  for (const row of [null, {}, { transaction_id: 't', account_id: 'a', amount: '12' },
    { transaction_id: 't', account_id: 'a', amount: NaN },
    { transaction_id: 't', account_id: 'a', amount: Infinity }]) {
    assert.throws(() => plaidTransaction(row), /invalid transaction record/);
  }
  for (const extra of [{ date: '2026-02-30' }, { amount: 1.001 }, { name: '' }]) {
    assert.throws(() => plaidTransaction({
      transaction_id: 'invalid', account_id: 'a', date: '2026-10-15', name: 'Market', amount: 12.50, ...extra
    }), { status: 502 });
  }
});

test('Plaid accepts zero-dollar authorizations without relaxing statement import validation', () => {
  const row = { transaction_id: 'auth', account_id: 'checking', date: '2026-11-09',
    name: 'BANK AUTHORIZATION', amount: 0, pending: true };
  assert.equal(plaidTransaction(row).amount, 0);
  assert.throws(() => validateImportedTransaction(plaidTransaction(row)), /positive value/);
  assert.throws(() => plaidTransaction({ ...row, amount: 1.001 }), {
    status: 502, code: 'PLAID_INVALID_TRANSACTION_AMOUNT'
  });
});

test('income detection rejects fixed bill credits and transfers without losing explicit deposit choices', () => {
  for (const description of ['PENNYMAC', 'STATE FARM', 'HYUNDAI LEASE', 'SANTANDER AUTO PAYMENT', 'AT&T AUTOPAY',
    'CREDIT CARD PAYMENT THANK YOU', 'REFUND', 'TRANSFER FROM SAVINGS']) {
    assert.equal(isIncomeTransaction({ direction: 'CREDIT', description, category: 'Other', is_fixed: true }), false, description);
  }
  assert.equal(isIncomeTransaction({ direction: 'CREDIT', description: 'RENT PAYMENT', income_role: 'income' }), true);
  assert.equal(isIncomeTransaction({ direction: 'CREDIT', description: 'STATE FARM PAYROLL', is_fixed: true }), true);
  assert.equal(isIncomeTransaction({ direction: 'CREDIT', description: 'ACME PAYROLL', category: 'Salary', transfer_kind: 'internal' }), false);
  assert.equal(isIncomeTransaction({ direction: 'CREDIT', description: 'ACME PAYROLL', income_role: 'other' }), false);
});

test('Plaid prefers the original bank description so payment recipients remain distinguishable', () => {
  const raw = {
    transaction_id: 'venmo-1', account_id: 'checking-1', date: '2026-10-15',
    amount: 100, name: 'Venmo', merchant_name: 'Venmo',
    original_description: '  VISA DDA PUR VENMO RECIPIENT ONE  '
  };
  const before = structuredClone(raw);
  assert.equal(plaidTransaction(raw).description, 'VISA DDA PUR VENMO RECIPIENT ONE');
  assert.notEqual(plaidTransaction(raw).description,
    plaidTransaction({ ...raw, original_description: 'VISA DDA PUR VENMO RECIPIENT TWO' }).description);
  for (const original_description of [undefined, null, '', '   ']) {
    assert.equal(plaidTransaction({ ...raw, original_description }).description, 'Venmo');
  }
  assert.equal(plaidTransaction({ ...raw, name: null, original_description: null }).description, 'Venmo');
  assert.deepEqual(raw, before);
});

test('Plaid access tokens are encrypted with authenticated encryption', () => {
  const previous = process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  process.env.PLAID_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    const encrypted = encryptPlaidToken('sandbox-access-token');
    assert.notEqual(encrypted, 'sandbox-access-token');
    assert.equal(decryptPlaidToken(encrypted), 'sandbox-access-token');
    const parts = encrypted.split(':');
    parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
    assert.throws(() => decryptPlaidToken(parts.join(':')));
    process.env.PLAID_TOKEN_ENCRYPTION_KEY = Buffer.alloc(16, 8).toString('base64');
    assert.throws(() => encryptPlaidToken('token'), { status: 503 });
  } finally {
    if (previous === undefined) delete process.env.PLAID_TOKEN_ENCRYPTION_KEY;
    else process.env.PLAID_TOKEN_ENCRYPTION_KEY = previous;
  }
});

test('Plaid webhook verification checks ES256 signature, freshness, and exact request body', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const keyId = '12345678-1234-4234-9234-123456789012';
  const plaidClient = {
    async webhookVerificationKeyGet() {
      return { data: { key: { ...jwk, alg: 'ES256', use: 'sig', kid: keyId } } };
    }
  };
  const rawBody = Buffer.from('{"webhook_type":"TRANSACTIONS","item_id":"item-1"}');
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iat: Math.floor(Date.now() / 1000),
    request_body_sha256: createHash('sha256').update(rawBody).digest('hex')
  })).toString('base64url');
  const signedContent = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(signedContent), {
    key: privateKey, dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  const jwt = `${signedContent}.${signature}`;
  assert.equal(await verifyPlaidWebhook(rawBody, jwt, plaidClient), true);
  assert.equal(await verifyPlaidWebhook(Buffer.from('{"modified":true}'), jwt, plaidClient), false);
  assert.equal(await verifyPlaidWebhook(rawBody, `${signedContent}.bad`, plaidClient), false);
});
