/* Household settings and owner-managed operator support access. */
(() => {
  const $ = id => document.getElementById(id);
  const { escape } = window.FinanceTools;
  const when = value => value ? new Date(value).toLocaleString() : '—';
  const view = document.createElement('section');
  view.id = 'settings-view';
  view.className = 'view';
  view.innerHTML = `<header class="header"><div><p class="eyebrow">YOUR ACCOUNT</p><h1>Settings &amp; support</h1>
      <p class="muted">Household members share and can edit financial records. Only the household owner manages support access. Operators can access operational information and audit metadata; support access to financial records requires an owner grant.</p></div></header>
    <div class="panel plan-card">
      <div><p class="eyebrow">SUPPORT ACCESS</p><h2>Let support help with a problem</h2>
        <p class="muted">Support never needs your password. The household owner can grant an administrator time-limited access to shared financial records. Support requests are logged below, and the owner can revoke access at any time.</p></div>
      <form id="support-grant-form" class="toolbar" hidden>
        <label>What do you need help with?<input id="support-reason" required minlength="5" maxlength="300" placeholder="e.g. Upcoming payments show the wrong amount"></label>
        <label>Access<select id="support-level"><option value="read">View only (recommended)</option><option value="write">View and make changes</option></select></label>
        <label>Duration<select id="support-hours"><option value="1">1 hour</option><option value="4">4 hours</option><option value="24" selected>24 hours</option><option value="72">3 days</option></select></label>
        <button class="btn btn-primary">Grant access</button>
      </form>
      <p id="support-status" role="status"></p>
      <h3>Your grants</h3><div id="support-grants" class="table-scroll"></div>
      <h3>Support activity on your account</h3><div id="support-activity" class="table-scroll"></div>
    </div>
    <div class="panel plan-card"><div><p class="eyebrow">LEARN MYFINANCE</p><h2>Watch the tutorials</h2>
      <p class="muted">One-minute narrated tours of the dashboard, the debt-free plan and savings goals.</p></div>
      <div><a class="btn btn-secondary" href="#tutorials">Open tutorials</a></div></div>
    <div class="panel plan-card"><div><p class="eyebrow">PERFORMANCE</p><h2>Diagnose slow pages</h2>
      <p class="muted">Start recording, visit the pages that feel slow, then return here and stop. Records page loads, panel processing, API timings and main-thread stalls. Kept only in this tab (up to 600 samples); cleared on sign-out or reload. No financial values, searches or statement contents are collected, and nothing is uploaded automatically.</p></div>
      <div class="toolbar"><button type="button" class="btn btn-primary" data-performance="start">Start recording</button>
        <button type="button" class="btn btn-secondary" data-performance="stop">Stop &amp; summarize</button>
        <button type="button" class="btn btn-secondary" data-performance="download">Download report</button>
        <button type="button" class="btn btn-secondary" data-performance="clear">Clear</button></div>
      <p id="performance-status" role="status">Not recording.</p>
      <div id="performance-summary" class="table-scroll"></div></div>
    <div class="panel plan-card" id="password-card"><div><p class="eyebrow">PASSWORD</p><h2>Change your password</h2>
      <p class="muted">Use at least 12 characters. You stay signed in here; every other device is signed out. Forgot your current password? Sign out and choose “Forgot your password?”.</p></div>
      <form id="password-form" class="toolbar">
        <label>Current password<input id="password-current" type="password" autocomplete="current-password" required></label>
        <label>New password<input id="password-new" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
        <label>Confirm new password<input id="password-confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
        <button class="btn btn-primary">Change password</button>
      </form>
      <p id="password-status" role="status"></p></div>
    <div class="panel plan-card" id="mfa-card"><div><p class="eyebrow">SIGN-IN SECURITY</p><h2>Authenticator verification (optional)</h2>
      <p class="muted">Add a six-digit code from your authenticator app to password sign-in. Save recovery codes offline: each works once if your device is lost. Password reset does not remove MFA. TOTP is not phishing-resistant; never share codes.</p></div>
      <p><a href="#tutorials/mfa">New to MFA? Follow the setup tutorial</a> &middot; <a href="#knowledge-base">Open the knowledge base and choose MFA &amp; sign-in security</a></p>
      <p class="muted">After signing in with a recovery code, the other unused codes still work. Replace the set if it may have been exposed or is running low: enter your password and an authenticator code or another unused recovery code, then choose Replace recovery codes. All old codes become invalid; save the ten new codes. This also forgets trusted browsers. Replacing codes does not restore a lost authenticator. Without an authenticator backup, disable MFA using your password and an unused recovery code, then immediately enroll the replacement device.</p>
      <p id="mfa-state" role="status"></p>
      <form id="mfa-form" class="toolbar" hidden>
        <label>Current password<input id="mfa-password" type="password" autocomplete="current-password" maxlength="128" required></label>
        <label>Authenticator or recovery code<input id="mfa-code" autocomplete="one-time-code" maxlength="32"></label>
        <button type="submit" class="btn btn-primary" id="mfa-submit">Set up authenticator</button>
        <button type="button" class="btn btn-secondary" id="mfa-regenerate" hidden>Replace recovery codes</button>
      </form>
      <div id="mfa-enrollment" hidden><p>In a SHA-256-capable authenticator, add an account manually using this setup key. Choose time-based codes, algorithm SHA-256 (not SHA-1), six digits and 30 seconds. If your app does not support selecting SHA-256, use a compatible authenticator. Enrollment expires in ten minutes. Enter the code above and confirm.</p><pre id="mfa-secret"></pre><p>Account: <span id="mfa-account"></span> / issuer: MyFinance</p></div>
      <div id="mfa-recovery" hidden><h3>Save these recovery codes now</h3><p>Shown only for this operation. Store them securely outside this browser. Each code works once. Replacing codes invalidates the entire old set.</p><pre id="mfa-codes"></pre><button type="button" class="btn btn-secondary" id="mfa-dismiss">I saved the codes; hide them</button></div>
      <p id="mfa-status" role="status"></p></div>
    <div class="panel plan-card"><div><p class="eyebrow">TRUSTED BROWSERS</p><h2>Manage remembered sign-ins</h2>
    <p class="muted">After MFA sign-in you can explicitly trust a personal browser for 90 days. It still requires your password, but skips the MFA prompt until trust expires or is revoked. Clearing cookies or using another browser requires MFA again. Normal sign-out keeps browser trust; session inactivity and lifetime limits are unchanged.</p>
    <p class="muted">A trusted cookie is not a hardware identity. Anyone with your password and that cookie can bypass the MFA prompt. Use Forget all trusted browsers after losing a device; it also signs out other active sessions.</p></div>
    <div id="trusted-browsers" class="table-scroll"></div>
    <button type="button" class="btn btn-secondary" id="trusted-revoke" hidden>Forget all trusted browsers</button>
    <p id="trusted-status" role="status"></p></div>`;
  document.querySelector('.main-content').appendChild(view);
  let mfaEnabled = false, mfaPending = false, mfaGeneration = 0;
  window.FinanceMfa = { reset() {
    mfaGeneration++;
    mfaPending = false;
    ['mfa-secret', 'mfa-codes'].forEach(id => { $(id).textContent = ''; });
    ['mfa-password', 'mfa-code'].forEach(id => { $(id).value = ''; });
    $('mfa-enrollment').hidden = true;
    $('mfa-recovery').hidden = true;
    $('trusted-browsers').textContent = '';
    $('trusted-status').textContent = '';
    $('trusted-revoke').hidden = true;
  } };
  async function loadMfa() {
    const blocked = FinanceSession.currentSupport() || FinanceSession.currentUser?.()?.email?.toLowerCase() === 'demo@myfinance.app';
    $('mfa-form').hidden = true;
    if (blocked) { FinanceMfa.reset(); $('mfa-state').textContent = 'Authenticator management is unavailable in demo or support sessions.'; return; }
    const generation = mfaGeneration;
    try {
      const response = await fetch('/api/auth/mfa');
      const data = await response.json();
      if (generation !== mfaGeneration || !FinanceSession.isAuthenticated()) return;
      if (!response.ok) throw new Error(data.error || 'Unable to load authenticator settings.');
      mfaEnabled = data.enabled;
      $('mfa-state').textContent = data.enabled ? `Enabled. ${data.recoveryCodesRemaining} recovery codes remain.` : 'Not enabled. Password-only sign-in.';
      $('mfa-submit').textContent = mfaEnabled ? 'Disable authenticator' : mfaPending ? 'Confirm authenticator' : 'Set up authenticator';
      $('mfa-regenerate').hidden = !mfaEnabled;
      $('mfa-code').required = mfaEnabled || mfaPending;
      $('mfa-form').hidden = false;
      const trustedResponse = await fetch('/api/auth/mfa/trusted-browsers');
      const trusted = await trustedResponse.json();
      if (generation !== mfaGeneration || !FinanceSession.isAuthenticated()) return;
      if (!trustedResponse.ok) throw new Error(trusted.error || 'Unable to load trusted browsers.');
      $('trusted-browsers').innerHTML = trusted.browsers.length
        ? `<table><thead><tr><th>Browser</th><th>Remembered</th><th>Last sign-in</th><th>Expires</th></tr></thead><tbody>${trusted.browsers.map((browser, i) =>
          `<tr><td>${browser.current ? 'This browser' : `Remembered browser ${i + 1}`}</td><td>${escape(when(browser.created_at))}</td><td>${escape(when(browser.last_used_at))}</td><td>${escape(when(browser.expires_at))}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">No trusted browsers. MFA-enabled logins require a code on untrusted browsers.</p>';
      $('trusted-revoke').hidden = !trusted.browsers.length;
    } catch (error) { if (generation === mfaGeneration) $('mfa-status').textContent = error.message; }
  }
  async function changeMfa(action) {
    if (action === 'disable' && !await FinanceUI.confirm('Disable authenticator verification? Future sign-ins will require only your password.')) return;
    const generation = mfaGeneration;
    $('mfa-submit').disabled = true;
    $('mfa-regenerate').disabled = true;
    $('mfa-status').textContent = '';
    try {
      const response = await fetch(`/api/auth/mfa/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('mfa-password').value, code: $('mfa-code').value.trim() }) });
      const data = await response.json();
      if (generation !== mfaGeneration || !FinanceSession.isAuthenticated()) return;
      if (!response.ok) throw new Error(data.error || 'Unable to change authenticator settings.');
      if (action === 'enroll') {
        mfaPending = true;
        $('mfa-secret').textContent = data.secret;
        $('mfa-account').textContent = FinanceSession.currentUser().email;
        $('mfa-enrollment').hidden = false;
      } else {
        mfaPending = false;
        $('mfa-secret').textContent = '';
        $('mfa-enrollment').hidden = true;
        $('mfa-codes').textContent = (data.recoveryCodes || []).join('\n');
        $('mfa-recovery').hidden = !data.recoveryCodes;
      }
      $('mfa-password').value = '';
      $('mfa-code').value = '';
      $('mfa-status').textContent = action === 'enroll' ? 'Setup key ready. Enter your password and authenticator code to confirm.' : 'Authenticator settings updated.';
      await loadMfa();
    } catch (error) { if (generation === mfaGeneration) $('mfa-status').textContent = error.message; }
    finally {
      if (generation === mfaGeneration) { $('mfa-submit').disabled = false; $('mfa-regenerate').disabled = false; }
    }
  }
  $('mfa-regenerate').addEventListener('click', () => changeMfa('recovery-codes'));
  $('mfa-dismiss').addEventListener('click', () => { $('mfa-codes').textContent = ''; $('mfa-recovery').hidden = true; });
  $('trusted-revoke').addEventListener('click', async () => {
    if (!await FinanceUI.confirm('Forget all trusted browsers and sign out other devices? Your current session stays open; future sign-ins require MFA.')) return;
    const generation = mfaGeneration;
    $('trusted-revoke').disabled = true;
    try {
      const response = await fetch('/api/auth/mfa/revoke-trusted-browsers', { method: 'POST' });
      const data = await response.json();
      if (generation !== mfaGeneration || !FinanceSession.isAuthenticated()) return;
      if (!response.ok) throw new Error(data.error || 'Unable to forget trusted browsers.');
      $('trusted-status').textContent = data.message;
      await loadMfa();
    } catch (error) { if (generation === mfaGeneration) $('trusted-status').textContent = error.message; }
    finally { if (generation === mfaGeneration) $('trusted-revoke').disabled = false; }
  });
  const canManageSupport = () => !FinanceSession.currentSupport() && FinanceSession.currentUser?.()?.household?.role === 'owner';

  function renderPasswordCard() {
    const user = FinanceSession.currentUser?.() || {};
    const blocked = FinanceSession.currentSupport() ? 'Password changes are not available during a support session.'
      : String(user.email || '').toLowerCase() === 'demo@myfinance.app' ? 'The demo account password cannot be changed.' : '';
    $('password-form').hidden = !!blocked;
    $('password-status').textContent = blocked;
  }

  async function changePassword() {
    const status = $('password-status');
    if ($('password-new').value !== $('password-confirm').value) { status.textContent = 'The new passwords do not match.'; return; }
    const button = $('password-form').querySelector('button');
    button.disabled = true;
    status.textContent = '';
    try {
      const response = await fetch('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: $('password-current').value, newPassword: $('password-new').value }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to change your password.');
      ['password-current', 'password-new', 'password-confirm'].forEach(id => { $(id).value = ''; });
      status.textContent = data.message;
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  }

  async function loadSettings() {
    await loadMfa();
    renderPerformance();
    renderPasswordCard();
    const status = $('support-status');
    $('support-grant-form').hidden = !canManageSupport();
    if (!canManageSupport()) {
      status.textContent = FinanceSession.currentSupport() ? 'Access-sharing settings are hidden during a support session.'
        : 'Only the household owner can grant or revoke operator support access and review support activity. Household members already share access to household finances.';
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
    if (event.target.id === 'mfa-form') {
      event.preventDefault();
      await changeMfa(mfaEnabled ? 'disable' : mfaPending ? 'confirm' : 'enroll');
      return;
    }
    if (event.target.id === 'password-form') { event.preventDefault(); await changePassword(); return; }
    if (event.target.id !== 'support-grant-form') return;
    event.preventDefault();
    if (!canManageSupport()) return;
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
    const action = event.target.closest?.('[data-performance]')?.dataset.performance;
    if (action) {
      window.FinancePerformance[action]();
      renderPerformance();
      return;
    }
    const id = event.target.dataset?.revoke;
    if (!id) return;
    if (!canManageSupport()) return;
    try {
      await fetch(`/api/support-access/${encodeURIComponent(id)}`, { method: 'DELETE' });
      $('support-status').textContent = 'Access revoked. Any active support session has ended.';
      await loadSettings();
    } catch (error) { $('support-status').textContent = error.message; }
  });

  function renderPerformance() {
    const report = window.FinancePerformance?.snapshot();
    if (!report) return;
    $('performance-status').textContent = `${report.enabled ? 'Recording' : 'Not recording'} · ${report.records.length} samples${report.dropped ? ` · ${report.dropped} older samples discarded` : ''}.${report.capabilities.longtask ? '' : ' Main-thread stall observation is unavailable in this browser.'}`;
    $('performance-summary').innerHTML = report.summary.length
      ? `<table><thead><tr><th>Type</th><th>Operation</th><th>Samples</th><th>Average ms</th><th>95th percentile ms</th><th>Worst ms</th></tr></thead><tbody>${report.summary.map(row =>
        `<tr><td>${escape(row.kind)}</td><td>${escape(row.name)}</td><td>${row.count}</td><td>${row.averageMs}</td><td>${row.p95Ms}</td><td>${row.maxMs}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No measurements yet. Start recording before reproducing the slowdown.</p>';
  }

  const baseShowView = window.showView;
  window.showView = function(name) {
    baseShowView(name);
    if (name === 'settings' && FinanceSession.isAuthenticated()) loadSettings().catch(error => { $('support-status').textContent = error.message; });
  };
})();
