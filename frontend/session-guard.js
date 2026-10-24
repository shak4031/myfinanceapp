/* Shared by the financial workspace and admin console. No financial data is broadcast or stored. */
window.FinanceSessionGuard = (() => {
  const nativeFetch = window.fetch.bind(window);
  const key = 'myfinance.session-event';
  let deadline = 0, timer = null, generation = 0, lastRenewal = 0;
  let renewing = false, validating = false;
  let activityTimer = null, lastInteraction = 0;
  let onLock = () => { document.body.textContent = 'Your session ended. Please sign in again.'; location.replace('/'); };
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(key) : null;
  function broadcast(message) {
    channel?.postMessage(message);
    try { globalThis.localStorage?.setItem(key, JSON.stringify({ ...message, nonce: Math.random() })); }
    catch (error) { console.warn('Cross-tab session storage is unavailable.', error.name); }
  }
  function conceal(hidden) { document.documentElement.style.visibility = hidden ? 'hidden' : ''; }
  function lock(message = 'Your session ended. Please sign in again.', announce = true) {
    generation++;
    deadline = 0;
    clearTimeout(timer);
    clearTimeout(activityTimer);
    if (announce) broadcast({ type: 'logout' });
    onLock(message);
    conceal(false);
  }
  function schedule(expires) {
    const parsed = Date.parse(expires);
    if (!Number.isFinite(parsed)) return;
    deadline = Math.max(deadline, parsed);
    clearTimeout(timer);
    if (deadline <= Date.now()) { lock(); return; }
    timer = setTimeout(expire, deadline - Date.now());
  }
  function observe(response, started) {
    const expires = response.headers?.get('X-Session-Idle-Expires');
    const serverTime = Date.parse(response.headers?.get('X-Session-Server-Time'));
    if (expires) {
      const remaining = Date.parse(expires) - serverTime - Math.max(0, Date.now() - started);
      schedule(Number.isFinite(remaining) ? new Date(Date.now() + remaining).toISOString() : expires);
    }
  }
  function expire() {
    if (!deadline) return;
    if (Date.now() < deadline) { schedule(new Date(deadline).toISOString()); return; }
    lock('You were signed out after 10 minutes of inactivity. Please sign in again.');
    nativeFetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
      .then(response => { if (!response.ok) console.warn('Session revocation failed; server expiry still applies.'); })
      .catch(error => console.warn('Session revocation unavailable; server expiry still applies.', error.name));
  }
  function receive(message) {
    if (message?.type === 'logout') lock('You signed out in another tab. Please sign in again.', false);
    // Treat activity messages only as a prompt to verify server state, never as authentication.
    else if (message?.type === 'activity' && deadline) revalidate();
  }
  if (channel) channel.onmessage = event => receive(event.data);
  window.addEventListener('storage', event => {
    if (event.key !== key || !event.newValue || channel) return;
    try { receive(JSON.parse(event.newValue)); }
    catch (error) { console.warn('Invalid cross-tab session notification.', error.name); }
  });
  async function revalidate() {
    if (!deadline || validating) return;
    if (deadline <= Date.now()) { expire(); return; }
    validating = true;
    conceal(true);
    const current = generation;
    const started = Date.now();
    try {
      const response = await nativeFetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (current !== generation) return;
      if (!response.ok) { lock('Your session could not be verified. Please sign in again.'); return; }
      observe(response, started);
    } catch {
      if (current === generation) lock('Your session could not be verified. Please sign in again.');
    } finally {
      validating = false;
      if (current === generation) conceal(false);
    }
  }
  async function renew() {
    if (!deadline) return;
    if (deadline <= Date.now()) { expire(); return; }
    if (renewing) { activityTimer = setTimeout(renew, 1000); return; }
    renewing = true;
    lastRenewal = Date.now();
    const current = generation;
    const started = Date.now();
    try {
      const response = await nativeFetch('/api/auth/activity', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idleMs: Math.min(15000, Math.max(0, Date.now() - lastInteraction)) })
      });
      if (current !== generation) return;
      if (!response.ok) { lock('Your session could not be renewed. Please sign in again.'); return; }
      observe(response, started);
      broadcast({ type: 'activity' });
    } catch {
      if (current === generation) lock('Your session could not be renewed. Please sign in again.');
    } finally { renewing = false; }
  }
  function activity(event) {
    if (!event.isTrusted || !deadline || document.visibilityState === 'hidden' || validating) return;
    if (deadline <= Date.now()) { expire(); return; }
    lastInteraction = Date.now();
    clearTimeout(activityTimer);
    const wait = lastRenewal + 15000 - Date.now();
    if (renewing || wait > 0) { activityTimer = setTimeout(renew, Math.max(100, wait)); return; }
    return renew();
  }
  for (const name of ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart']) {
    document.addEventListener(name, activity, { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (!deadline) return;
    if (document.visibilityState === 'hidden') conceal(true);
    else revalidate();
  });
  window.addEventListener('focus', revalidate);
  window.addEventListener('pageshow', revalidate);
  window.fetch = async (resource, options = {}) => {
    const url = new URL(typeof resource === 'string' ? resource : resource.url, location.href);
    const api = url.origin === location.origin && url.pathname.startsWith('/api/');
    const current = generation;
    const started = Date.now();
    if (api && deadline && deadline <= Date.now()) { expire(); throw new Error('Session expired. Please sign in again.'); }
    const response = await nativeFetch(resource, { ...options, ...(api ? { credentials: 'same-origin' } : {}) });
    if (!api) return response;
    if (current !== generation) throw new Error('Session changed. Request discarded.');
    if (response.status === 401 && deadline) lock();
    else observe(response, started);
    for (const method of ['json', 'text']) {
      const parse = response[method]?.bind(response);
      if (!parse) continue;
      response[method] = async () => {
        const body = await parse();
        if (current !== generation) throw new Error('Session changed. Response discarded.');
        return body;
      };
    }
    return response;
  };
  return { configure(callback) { onLock = callback; }, end: lock };
})();
