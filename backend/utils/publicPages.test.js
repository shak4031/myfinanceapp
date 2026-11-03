import assert from 'node:assert/strict';
import test from 'node:test';
import application from '../app.js';

test('About and Contact have separate public URLs, accessible navigation and honest security copy', async () => {
  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [path, title] of [['/about', 'About MyFinance'], ['/contact', 'Contact MyFinance']]) {
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
      } else {
        assert.match(html, /Never email passwords, verification codes, full account numbers/);
        assert.match(html, /href="mailto:/);
      }
    }
    assert.equal((await fetch(base + '/public-pages.css')).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
