// Opt-in, bounded diagnostics. No financial content or telemetry is sent to a server.
(() => {
  const limit = 600, records = [], observers = [];
  const pages = new Set(['dashboard', 'categories', 'category-admin', 'transactions', 'accounts', 'analytics', 'compass', 'etl', 'payoff', 'goals', 'insights', 'tutorials', 'settings']);
  const endpoints = new Set([
    '/api/auth/me', '/api/license', '/api/analytics', '/api/analytics/compass', '/api/plan',
    '/api/categories', '/api/accounts', '/api/debts', '/api/goals', '/api/budgets', '/api/support-access',
    ...['summary', 'upcoming-payments', 'category-spending', 'all-transactions', 'monthly-cashflow', 'insights', 'spending-history'].map(name => `/api/dashboard/${name}`),
    ...['categorization-rules', 'categorization-apply', 'name-rules', 'rename', 'update-fixed', 'update-pay-mode', 'update-income-role'].map(name => `/api/transactions/${name}`)
  ]);
  let enabled = false, generation = 0, startedAt = null, dropped = 0;
  const now = () => performance.now();
  const round = value => Math.round(value * 100) / 100;
  const pageName = () => {
    const route = location.hash.slice(1);
    const name = route === 'analytics/compass' ? 'compass' : route.split('/')[0];
    return pages.has(name) ? name : 'dashboard';
  };
  function add(kind, name, duration, start, extra = {}, page = pageName()) {
    if (!enabled || !Number.isFinite(duration) || duration < 0) return;
    if (records.length === limit) { records.shift(); dropped++; }
    records.push({ kind, name, page, startMs: round(start), durationMs: round(duration), ...extra });
  }
  function begin(kind, name) {
    if (!enabled) return () => {};
    const start = now(), run = generation, page = pageName();
    return (outcome = 'ok') => {
      if (run !== generation) return;
      add(kind, name, now() - start, start, { outcome }, page);
    };
  }
  function measure(kind, name, callback) {
    const finish = begin(kind, name);
    try { const value = callback(); finish(); return value; }
    catch (error) { finish('error'); throw error; }
  }
  function observe(type, callback) {
    if (!globalThis.PerformanceObserver?.supportedEntryTypes?.includes(type)) return;
    const observer = new PerformanceObserver(list => list.getEntries().forEach(callback));
    observer.observe({ type, buffered: false });
    observers.push(observer);
  }
  function stop() {
    for (const observer of observers) observer.disconnect();
    observers.length = 0;
    enabled = false;
    generation++;
  }
  function clear() {
    stop(); records.length = 0; dropped = 0; startedAt = null;
  }
  function start() {
    clear(); enabled = true; startedAt = new Date().toISOString();
    const navigation = performance.getEntriesByType?.('navigation')?.[0];
    if (navigation) {
      add('navigation', 'document', navigation.duration, navigation.startTime, {
        ttfbMs: round(navigation.responseStart), domReadyMs: round(navigation.domContentLoadedEventEnd)
      });
    }
    observe('longtask', entry => add('longtask', 'main-thread', entry.duration, entry.startTime));
    observe('resource', entry => {
      if (!['fetch', 'xmlhttprequest'].includes(entry.initiatorType)) return;
      const url = new URL(entry.name, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return;
      add('request', endpoints.has(url.pathname) ? url.pathname : '/api/other', entry.duration, entry.startTime, {
        ttfbMs: round(Math.max(0, entry.responseStart - entry.startTime)),
        downloadMs: round(Math.max(0, entry.responseEnd - entry.responseStart)),
        bytes: entry.encodedBodySize,
        server: (entry.serverTiming || []).filter(t => ['app', 'inputs', 'plan', 'analytics', 'compass'].includes(t.name))
          .map(t => ({ name: t.name, durationMs: round(t.duration) }))
      });
    });
  }
  function snapshot() {
    const groups = new Map();
    for (const record of records) {
      const key = `${record.kind}:${record.name}`;
      if (!groups.has(key)) groups.set(key, { kind: record.kind, name: record.name, values: [] });
      groups.get(key).values.push(record.durationMs);
    }
    const summary = [...groups.values()].map(({ kind, name, values }) => {
      values.sort((a, b) => a - b);
      return { kind, name, count: values.length, averageMs: round(values.reduce((a, b) => a + b, 0) / values.length),
        p95Ms: values[Math.ceil(values.length * 0.95) - 1], maxMs: values.at(-1) };
    }).sort((a, b) => b.maxMs - a.maxMs);
    return { version: 1, enabled, startedAt, capacity: limit, dropped,
      capabilities: { resource: !!globalThis.PerformanceObserver?.supportedEntryTypes?.includes('resource'),
        longtask: !!globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask') },
      summary, records: records.map(record => ({ ...record })) };
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'myfinance-performance.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  globalThis.FinancePerformance = { start, stop, clear, begin, measure, snapshot, download };
})();
