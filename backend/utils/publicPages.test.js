import assert from 'node:assert/strict';
import test from 'node:test';
import application from '../app.js';
import { PUBLIC_PAGES } from './publicSeo.js';
import { PRICES } from './billing.js';

test('About and Contact have separate public URLs, accessible navigation and honest security copy', async () => {
  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [path, title] of [['/about', 'About MyFinance'], ['/contact', 'Contact MyFinance'], ['/security', 'Security Whitepaper']]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.match(response.headers.get('cache-control'), /no-cache/);
      const html = await response.text();
      assert.match(html, new RegExp(`<title>${title}`));
      assert.match(html, /Skip to content/);
      assert.match(html, new RegExp(`href="${path}" aria-current="page"`));
      assert.match(html, /href="\/public-pages\.css\?v=/);
      assert.match(html, /href="\/#marketing-signin"/);
      if (path === '/about') {
        assert.match(html, /AES-256-GCM/);
        assert.match(html, /No online service can guarantee zero risk/);
        assert.match(html, /Authorized operators retain infrastructure access/);
      } else if (path === '/contact') {
        assert.match(html, /Never email passwords, verification codes, full account numbers/);
        assert.match(html, /href="mailto:/);
      } else {
        assert.match(html, /MF-SEC-001/);
        assert.match(html, /Security, in plain English/);
        assert.match(html, /What we protect:/);
        assert.match(html, /What to know:/);
        assert.match(html, /Save recovery codes separately from your phone/);
        assert.match(html, /Only trust personal browsers/);
        assert.ok(html.indexOf('id="security-summary"') < html.indexOf('id="identity-enhancements"'));
        assert.match(html, /version 1\.6/);
        assert.match(html, /Stronger account protection: beyond passwords/);
        assert.match(html, /a stolen password alone is insufficient/);
        assert.match(html, /Authenticator protection requires successful enrollment by each user/);
        assert.match(html, /QR setup improves usability; it is not an additional authentication factor/);
        assert.match(html, /Account-protection validation/);
        assert.match(html, /207 passing tests/);
        assert.match(html, /HMAC-SHA-1 with a random 160-bit secret/);
        assert.match(html, /algorithm=SHA1/);
        assert.match(html, /Known SHA-1 collision attacks do not directly break/);
        assert.match(html, /Replacing recovery codes does not restore a lost authenticator/);
        assert.match(html, /TOTP is not phishing-resistant/);
        assert.match(html, /Trust this browser for 90 days/);
        assert.match(html, /fixed ninety-day expiry/);
        assert.match(html, /stolen trust cookie together with a stolen password/);
        assert.match(html, /Optional authenticator MFA and recovery/);
        assert.match(html, /Password resets preserve MFA/);
        assert.match(html, /administrators can disable MFA after independently verifying the account owner/);
        assert.match(html, /re-enrollment and a waiting period are not enforced/);
        assert.match(html, /Recorded production verification/);
        assert.match(html, /WireGuard/);
        assert.match(html, /database TLS operator-verified on 4 November 2026/);
        assert.match(html, /not an independent infrastructure audit/);
        assert.doesNotMatch(html, /Cipher suites: baseline|TLS_AES_|TLS_CHACHA|may negotiate|specific TLS cipher suites have not been confirmed/);
        assert.match(html, /AES-256-GCM/);
        assert.match(html, /N=32768, r=8, p=1/);
        assert.match(html, /not field-level encrypted/);
        assert.match(html, /not end-to-end encryption or zero-knowledge storage/);
        assert.match(html, /does store account metadata, balances and transaction history/);
        assert.equal((html.match(/<svg /g) || []).length, 2);
        assert.equal((html.match(/role="img" aria-labelledby=/g) || []).length, 2);
        assert.doesNotMatch(html, /<script/);
      }
    }
    const home = await (await fetch(base + '/')).text();
    assert.match(home, /href="\/security">Security/);
    assert.match(home, /Read the technical security whitepaper/);
    const signup = await fetch(base + '/signup');
    assert.equal(signup.status, 200);
    assert.match(signup.headers.get('x-robots-tag'), /noindex/);
    assert.match(await signup.text(), /id="auth-form"/);
    assert.equal((await fetch(base + '/public-pages.css')).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('public SEO serves crawlable HTML, accurate pricing and only canonical public URLs in the sitemap', async () => {
  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = process.env.APP_ORIGIN || 'https://myfinanceapp.us';
  try {
    for (const path of Object.keys(PUBLIC_PAGES)) {
      const response = await fetch(base + path + '?campaign=test');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-robots-tag'), null);
      const html = await response.text();
      assert.equal((html.match(/<h1\b/gi) || []).length, 1, path);
      assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
      assert.ok(html.includes(`rel="canonical" href="${origin}${path}"`));
      assert.match(html, /property="og:title"/);
      assert.match(html, /property="og:url"/);
      assert.doesNotMatch(html, /<meta[^>]+noindex/i);
      if (['/', '/features', '/pricing', '/debt-payoff'].includes(path)) {
        const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
        assert.equal(schema['@type'], 'SoftwareApplication');
        assert.deepEqual(schema.offers.map(offer => offer.price), Object.values(PRICES).map(cents => (cents / 100).toFixed(2)));
        assert.ok(schema.offers.every(offer => offer.priceCurrency === 'USD' && offer.priceSpecification.unitText === 'MONTH'));
      }
      if (path === '/pricing') {
        assert.match(html, /\$9\.99/);
        assert.match(html, /\$14\.99/);
        assert.match(html, /15-day Pro trial/);
        assert.match(html, /bills automatically/);
      }
      if (path === '/features') assert.match(html, /30-day cash flow forecast/);
      if (path === '/debt-payoff') assert.match(html, /Snowball or avalanche/);
    }
    const robots = await (await fetch(base + '/robots.txt')).text();
    assert.match(robots, /User-agent: \*\nAllow: \//);
    assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`));
    assert.match(robots, /Disallow: \/api\//);
    const sitemapResponse = await fetch(base + '/sitemap.xml');
    assert.match(sitemapResponse.headers.get('content-type'), /xml/);
    const sitemap = await sitemapResponse.text();
    assert.match(sitemap, /xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"/);
    assert.deepEqual([...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]),
      Object.keys(PUBLIC_PAGES).map(path => origin + path));
    for (const path of ['/admin.html', '/reset-password.html', '/app', '/unknown-page', '/api/health']) {
      assert.match((await fetch(base + path)).headers.get('x-robots-tag'), /noindex/);
    }
    for (const [path, target] of [['/index.html', '/'], ['/about.html', '/about'], ['/contact.html', '/contact'], ['/security.html', '/security']]) {
      const response = await fetch(base + path, { redirect: 'manual' });
      assert.equal(response.status, 301);
      assert.equal(response.headers.get('location'), target);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
