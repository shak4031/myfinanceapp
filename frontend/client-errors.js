(() => {
  const recent = new Map();
  const cleanMessage = value => String(value || 'Unknown browser error')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\b(password|token|secret|cookie|authorization|amount|balance|description)\s*[:=]\s*[^,;]+/gi, '$1=[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/(?:[$€£]\s*)-?\d[\d,]*(?:\.\d{1,2})?/g, '[amount]')
    .replace(/\b\d{8,}\b/g, '[number]')
    .slice(0, 500);

  function report(name, message, file = '', line = null, column = null) {
    if (!window.FinanceSession?.isAuthenticated()) return;
    const safeName = String(name || 'Error').slice(0, 80);
    const safeMessage = cleanMessage(message);
    const key = `${safeName}:${safeMessage}:${file}`;
    const now = Date.now();
    if (now - (recent.get(key) || 0) < 60000) return;
    recent.set(key, now);
    if (recent.size > 50) recent.delete(recent.keys().next().value);
    fetch('/api/client-errors', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: safeName, message: safeMessage, file, line, column }),
      keepalive: true
    }).catch(error => console.error('Could not submit browser error report', error));
  }

  addEventListener('error', event => {
    let file = '';
    try {
      const url = new URL(event.filename || '', location.href);
      if (url.origin !== location.origin) return;
      file = url.pathname.split('/').pop().slice(0, 120);
    } catch { /* No usable source URL. */ }
    report(event.error?.name || 'Error', event.message, file, event.lineno, event.colno);
  });

  addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    report(reason instanceof Error ? reason.name : 'Unhandled rejection',
      reason instanceof Error ? reason.message : 'A promise was rejected without an Error',
      '', null, null);
  });
})();
