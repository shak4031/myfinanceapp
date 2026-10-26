import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./session-guard.js', import.meta.url), 'utf8');
function server() {
  return { now: Date.parse('2026-10-23T12:00:00Z'), deadline: Date.parse('2026-10-23T12:10:00Z'),
    channels: [], calls: [], revoked: false };
}
function fixture(shared, { storageOnly = false, clockSkew = 0 } = {}) {
  const events = new Map(), timers = new Map(), locked = [];
  let nextTimer = 0;
  const response = (status = 200) => {
    const now = shared.now, deadline = shared.deadline;
    return ({
    status, ok: status === 200,
    headers: { get: name => name.toLowerCase() === 'x-session-idle-expires' && status === 200 ? new Date(deadline).toISOString()
      : name.toLowerCase() === 'x-session-server-time' ? new Date(now).toISOString() : null },
    json: async () => ({ user: { id: 1 } }), text: async () => '{"private":"financial content"}'
    });
  };
  const native = async (url, options) => {
    shared.calls.push({ url, options });
    if (url === '/api/auth/logout') { shared.revoked = true; return response(); }
    if (shared.revoked || shared.now >= shared.deadline) return response(401);
    if (url === '/api/auth/activity') shared.deadline = shared.now + 600000 - (JSON.parse(options.body || '{}').idleMs || 0);
    if (url === '/api/slow') { const result = response(); shared.now += 120000; return result; }
    return response();
  };
  const context = {
    console, URL, Math, Number, String, JSON, Promise,
    Date: class extends Date { static now() { return shared.now + clockSkew; } },
    location: { href: 'https://local.test/', origin: 'https://local.test', replace() {} },
    document: {
      visibilityState: 'visible', documentElement: { style: {} }, body: { textContent: 'private' },
      addEventListener: (name, handler) => events.set(name, handler)
    },
    addEventListener: (name, handler) => events.set(name, handler),
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: shared.now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: native, localStorage: { setItem() {} },
    BroadcastChannel: storageOnly ? undefined : class {
      constructor() { shared.channels.push(this); }
      postMessage(message) { for (const other of shared.channels) if (other !== this) other.onmessage?.({ data: message }); }
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  context.FinanceSessionGuard.configure(message => {
    locked.push(message);
    context.document.body.textContent = '';
  });
  return { context, events, timers, locked, response, async start() { await context.fetch('/api/auth/me'); },
    fire(name, event = {}) { return events.get(name)?.(event); },
    tick(ms) {
      shared.now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= shared.now) { timers.delete(id); timer.fn(); }
    }
  };
}
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test('idle timer locks at ten minutes without further API traffic and revokes the cookie', async () => {
  const shared = server(), f = fixture(shared);
  await f.start();
  f.tick(599999);
  assert.equal(f.locked.length, 0);
  f.tick(1);
  await settle();
  assert.match(f.locked[0], /10 minutes of inactivity/);
  assert.equal(f.context.document.body.textContent, '');
  assert.equal(shared.revoked, true);
});

test('polling and synthetic events never renew; trusted interaction renews with throttling', async () => {
  const shared = server(), f = fixture(shared);
  await f.start();
  shared.now += 300000;
  await f.context.fetch('/api/accounts');
  await f.fire('pointermove', { isTrusted: false });
  assert.equal(shared.calls.filter(call => call.url === '/api/auth/activity').length, 0);
  await f.fire('keydown', { isTrusted: true });
  assert.equal(shared.deadline, shared.now + 600000);
  await f.fire('pointermove', { isTrusted: true });
  assert.equal(shared.calls.filter(call => call.url === '/api/auth/activity').length, 1);
  f.tick(15000);
  await settle();
  assert.equal(shared.deadline, shared.now + 585000, 'throttled renewal records actual interaction time, not timer time');
  f.tick(285001);
  assert.equal(f.locked.length, 0, 'the original deadline no longer logs out active users');
  f.tick(299999);
  assert.equal(f.locked.length, 1);
});

test('logout locks all tabs immediately and rejects pending confidential responses', async () => {
  const shared = server(), first = fixture(shared), second = fixture(shared);
  await first.start(); await second.start();
  const pending = await second.context.fetch('/api/accounts');
  first.context.FinanceSessionGuard.end();
  assert.equal(first.locked.length, 1);
  assert.equal(second.locked.length, 1);
  assert.equal(second.context.document.body.textContent, '');
  await assert.rejects(pending.json(), /Session changed/);
  await assert.rejects(pending.text(), /Session changed/);
});

test('activity in one tab renews the others only after verifying server state', async () => {
  const shared = server(), first = fixture(shared), second = fixture(shared);
  await first.start(); await second.start();
  shared.now += 300000;
  await first.fire('scroll', { isTrusted: true });
  await settle();
  second.tick(300001);
  assert.equal(second.locked.length, 0);
  assert.ok(shared.calls.filter(call => call.url === '/api/auth/me').length >= 3);
});

test('hidden and restored pages conceal content until a nonrenewing session check succeeds', async () => {
  const shared = server(), f = fixture(shared);
  await f.start();
  f.context.document.visibilityState = 'hidden';
  f.fire('visibilitychange');
  assert.equal(f.context.document.documentElement.style.visibility, 'hidden');
  f.context.document.visibilityState = 'visible';
  await f.fire('visibilitychange');
  await settle();
  assert.equal(f.context.document.documentElement.style.visibility, '');
  assert.equal(shared.calls.filter(call => call.url === '/api/auth/activity').length, 0);
  shared.revoked = true;
  await f.fire('pageshow');
  assert.equal(f.locked.length, 1, 'restored pages fail closed if the session was revoked');
});

test('storage fallback synchronizes logout and a suspended tab checks its deadline on focus', async () => {
  const shared = server(), f = fixture(shared, { storageOnly: true });
  await f.start();
  f.fire('storage', { key: 'myfinance.session-event', newValue: JSON.stringify({ type: 'logout' }) });
  assert.equal(f.locked.length, 1);
  const other = fixture(server(), { storageOnly: true });
  await other.start();
  other.fire('storage', { key: 'unrelated', newValue: '{}' });
  assert.equal(other.locked.length, 0);
  const sleeping = server(), suspended = fixture(sleeping);
  await suspended.start();
  sleeping.now += 600000; // No timer runs while the page is suspended.
  await suspended.fire('focus');
  assert.equal(suspended.locked.length, 1);
});

test('browser clock skew does not bypass or prematurely expire the ten-minute deadline', async () => {
  for (const clockSkew of [-3600000, 3600000]) {
    const shared = server(), f = fixture(shared, { clockSkew });
    await f.start();
    f.tick(599999);
    assert.equal(f.locked.length, 0);
    f.tick(1);
    assert.equal(f.locked.length, 1);
  }
});

test('the final interaction within a throttle window receives a full ten-minute inactivity period', async () => {
  const shared = server(), f = fixture(shared);
  await f.start();
  await f.fire('pointerdown', { isTrusted: true });
  f.tick(14000);
  await f.fire('keydown', { isTrusted: true });
  f.tick(1000);
  await settle();
  f.tick(598999);
  assert.equal(f.locked.length, 0);
  f.tick(1);
  assert.equal(f.locked.length, 1);
});

test('a slow financial response does not extend the local inactivity deadline', async () => {
  const shared = server(), f = fixture(shared);
  await f.start();
  await f.context.fetch('/api/slow');
  f.tick(479999);
  assert.equal(f.locked.length, 0);
  f.tick(1);
  assert.equal(f.locked.length, 1);
});
