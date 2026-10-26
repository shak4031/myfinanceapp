import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { decryptPlaidToken, encryptPlaidToken, verifyPlaidWebhook } from './plaid.js';

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
