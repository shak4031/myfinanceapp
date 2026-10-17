/* Settings & support: customers control exactly when support may view their account. */
(() => {
  const $ = id => document.getElementById(id);
  const { escape } = window.FinanceTools;
  const when = value => value ? new Date(value).toLocaleString() : '—';
  const view = document.createElement('section');
  view.id = 'settings-view';
  view.className = 'view';
  view.innerHTML = `<header class="header"><div><p class="eyebrow">YOUR ACCOUNT</p><h1>Settings &amp; support</h1>
      <p class="muted">You decide if and when support can look at your account. Nobody can see your data without a grant from you.</p></div></header>
    <div class="panel plan-card">
      <div><p class="eyebrow">SUPPORT ACCESS</p><h2>Let support help with a problem</h2>
        <p class="muted">Support never needs your password. A grant lets an administrator view your account for a limited time. Every page they open is logged below, and you can revoke access instantly.</p></div>
      <form id="support-grant-form" class="toolbar">
        <label>What do you need help with?<input id="support-reason" required minlength="5" maxlength="300" placeholder="e.g. Upcoming payments show the wrong amount"></label>
        <label>Access<select id="support-level"><option value="read">View only (recommended)</option><option value="write">View and make changes</option></select></label>
        <label>Duration<select id="support-hours"><option value="1">1 hour</option><option value="4">4 hours</option><option value="24" selected>24 hours</option><option value="72">3 days</option></select></label>
        <button class="btn btn-primary">Grant access</button>
      </form>
      <p id="support-status" role="status"></p>
      <h3>Your grants</h3><div id="support-grants" class="table-scroll"></div>
      <h3>Support activity on your account</h3><div id="support-activity" class="table-scroll"></div>
    </div>
    <div class="panel plan-card"><div><p class="eyebrow">PASSWORD</p><h2>Forgot or want to change your password?</h2>
      <p class="muted">Sign out and choose “Forgot your password?”. We will email a single-use link that expires in 30 minutes and signs out all devices once used.</p></div></div>`;
  document.querySelector('.main-content').appendChild(view);

  async function loadSettings() {
    const status = $('support-status');
    if (FinanceSession.currentSupport()) {
      $('support-grant-form').hidden = true;
      status.textContent = 'Access-sharing settings are hidden during a support session.';
      $('support-grants').innerHTML = '';
      $('support-activity').innerHTML = '';
      return;
    }
    const data = await (await fetch('/api/support-access')).json();
    $('support-grants').innerHTML = data.grants.length ? `<table><thead><tr><th>Reason</th><th>Access</th><th>Expires</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>${
      data.grants.map(grant => `<tr><td>${escape(grant.reason)}</td><td>${grant.accessLevel === 'write' ? 'View &amp; edit' : 'View only'}</td><td>${escape(when(grant.expiresAt))}</td><td>${escape(when(grant.lastUsedAt))}</td>
        <td>${grant.active ? '<span class="pill">Active</span>' : grant.revokedAt ? 'Revoked' : 'Expired'}</td>
        <td>${grant.active ? `<button class="btn btn-secondary" data-revoke="${Number(grant.id)}">Revoke now</button>` : ''}</td></tr>`).join('')
    }</tbody></table>` : '<p class="muted">You have not granted support access.</p>';
    $('support-activity').innerHTML = data.activity.length ? `<table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Result</th></tr></thead><tbody>${
      data.activity.map(row => `<tr><td>${escape(when(row.created_at))}</td><td>${escape(row.actor_name || 'You')}</td>
        <td>${escape(row.event_type === 'support.request' ? `${row.method} ${row.path}` : row.event_type.replace('support.', '').replaceAll('_', ' '))}</td>
        <td>${escape(row.status ? (row.status < 400 ? 'Allowed' : `Blocked (${row.status})`) : row.outcome)}</td></tr>`).join('')
    }</tbody></table>` : '<p class="muted">No support activity yet.</p>';
  }

  view.addEventListener('submit', async event => {
    if (event.target.id !== 'support-grant-form') return;
    event.preventDefault();
    const level = $('support-level').value;
    if (level === 'write' && !await FinanceUI.confirm('Allow support to make changes to your data? Changes are logged, and you can revoke access at any time.')) return;
    try {
      await fetch('/api/support-access', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: $('support-reason').value.trim(), accessLevel: level, hours: Number($('support-hours').value) }) });
      $('support-reason').value = '';
      $('support-status').textContent = 'Access granted. Tell support it is ready; they will not see your password.';
      await loadSettings();
    } catch (error) { $('support-status').textContent = error.message; }
  });
  view.addEventListener('click', async event => {
    const id = event.target.dataset?.revoke;
    if (!id) return;
    try {
      await fetch(`/api/support-access/${encodeURIComponent(id)}`, { method: 'DELETE' });
      $('support-status').textContent = 'Access revoked. Any active support session has ended.';
      await loadSettings();
    } catch (error) { $('support-status').textContent = error.message; }
  });

  const baseShowView = window.showView;
  window.showView = function(name) {
    baseShowView(name);
    if (name === 'settings' && FinanceSession.isAuthenticated()) loadSettings().catch(error => { $('support-status').textContent = error.message; });
  };
})();
