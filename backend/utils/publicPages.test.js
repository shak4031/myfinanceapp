import assert from 'node:assert/strict';
import test from 'node:test';
import application from '../app.js';

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
        assert.match(html, /AES-256-GCM/);
        assert.match(html, /N=32768, r=8, p=1/);
        assert.match(html, /TLS_AES_256_GCM_SHA384/);
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
    assert.equal((await fetch(base + '/public-pages.css')).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
