/* Household settings and owner-managed operator support access. */
(() => {
  const $ = id => document.getElementById(id);
  const { escape } = window.FinanceTools;
  const when = value => value ? new Date(value).toLocaleString() : '—';
  const view = document.createElement('section');
  view.id = 'settings-view';
  view.className = 'view settings-view';
  view.innerHTML = `<header class="settings-hero"><div><p class="eyebrow">YOUR WORKSPACE, YOUR WAY</p><h2>How can we help?</h2>
      <p>Get support, look after your sign-in security, or find your household plan.</p></div><span class="settings-hero-icon" aria-hidden="true">&#10022;</span></header>
    <nav class="settings-shortcuts" aria-label="Account and support shortcuts">
      <a href="#membership"><strong>Profile &amp; membership</strong><span>Choose a plan or manage your household &rarr;</span></a>
      <a href="#knowledge-base"><strong>Knowledge Base</strong><span>Find answers and helpful guides &rarr;</span></a>
      <a href="#tutorials"><strong>Tutorials</strong><span>Explore MyFinance at your own pace &rarr;</span></a>
    </nav>
    <div class="panel plan-card support-ticket-panel" id="support-ticket-card">
      <div><p class="eyebrow">CONTACT SUPPORT</p><h2>Open a support case</h2>
        <p class="muted">Tell us what went wrong. You will receive a ticket number and can follow its progress below.</p>
        <p class="muted">Support is notified at <a href="mailto:myfinanceapp.support@gmail.com">myfinanceapp.support@gmail.com</a>.</p></div>
      <p class="support-ticket-notice">Never include passwords, verification codes or full account numbers. Opening a ticket does not give support access to your financial records.</p>
      <form id="support-ticket-form" class="support-ticket-form">
        <div class="support-ticket-field"><label for="support-ticket-description">Description (required)</label>
          <textarea id="support-ticket-description" class="input" rows="5" required minlength="10" maxlength="5000" aria-describedby="support-description-hint" placeholder="What happened, and what did you expect?"></textarea>
          <small id="support-description-hint">Use 10 to 5,000 characters. Include the page name and any error message.</small></div>
        <div class="support-ticket-field"><label for="support-ticket-category">Category (optional)</label>
          <input id="support-ticket-category" maxlength="80" placeholder="e.g. Bank sync or sign-in"></div>
        <div><button type="submit" class="btn btn-primary">Submit support case</button></div>
      </form>
      <p id="support-ticket-status" role="status" aria-live="polite"></p>
      <section class="support-ticket-history-section" aria-labelledby="support-history-title">
        <div class="support-ticket-history-heading"><h3 id="support-history-title">Your latest 20 tickets</h3><button type="button" class="btn btn-secondary" id="support-ticket-refresh">Refresh tickets</button></div>
        <p class="muted">Open = received. In progress = support is working on it. Resolved = completed.</p>
        <div id="support-ticket-history"></div>
      </section>
      <a href="#knowledge-base" class="support-ticket-guide">How support tickets and support access work</a>
    </div>
    <div class="panel plan-card">
      <div><p class="eyebrow">SUPPORT ACCESS</p><h2>Let support help with a problem</h2>
        <p class="muted">Support never needs your password. Operators can access operational information and audit metadata; access to financial records requires an owner grant. The household owner can grant an administrator time-limited access to shared financial records. Access and actions are logged below, and the owner can revoke access at any time. Case descriptions and updates belong in the support card above.</p></div>
      <form id="support-grant-form" class="toolbar" hidden>
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
      <div id="mfa-enrollment" hidden><p>Open an authenticator such as Google Authenticator or Microsoft Authenticator on your phone, choose Add account and Scan QR code, then scan the image below. In Microsoft Authenticator, select Other account rather than a work/school or Microsoft account. The QR includes the account and code settings automatically. Enrollment expires in ten minutes. Enter your password and the six-digit code above, then choose Confirm authenticator.</p><img id="mfa-qr" width="280" height="280" style="max-width:100%;height:auto" alt="Private MyFinance authenticator enrollment QR code. Scan with your authenticator; do not share."><p id="mfa-qr-error" role="alert" hidden>QR image could not be displayed. Use the manual setup key below or restart setup.</p><details><summary>Cannot scan? Set up manually</summary><p>On the same phone, switch between this browser and your authenticator. Add an account manually using this setup key. Choose time-based codes, algorithm SHA-1, six digits and 30 seconds (the standard TOTP defaults). In Google Authenticator choose Enter a setup key and Time based; other apps may label these options differently. The QR code and setup key are private: never share or send them to support.</p><pre id="mfa-secret"></pre><p>Account: <span id="mfa-account"></span> / issuer: MyFinance</p></details></div>
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
  $('mfa-qr').addEventListener('error', () => {
    $('mfa-qr').hidden = true;
    $('mfa-qr-error').hidden = false;
  });
  const clearEnrollment = () => {
    $('mfa-secret').textContent = '';
    $('mfa-qr').removeAttribute('src');
    $('mfa-qr').hidden = true;
    $('mfa-qr-error').hidden = true;
    $('mfa-enrollment').hidden = true;
  };
  window.FinanceMfa = { reset() {
    mfaGeneration++;
    mfaPending = false;
    ['mfa-secret', 'mfa-codes'].forEach(id => { $(id).textContent = ''; });
    ['mfa-password', 'mfa-code'].forEach(id => { $(id).value = ''; });
    clearEnrollment();
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
        if (typeof data.qrCode !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(data.qrCode)) {
          throw new Error('Authenticator QR setup could not be loaded. Start setup again.');
        }
        mfaPending = true;
        $('mfa-secret').textContent = data.secret;
        $('mfa-qr-error').hidden = true;
        $('mfa-qr').hidden = false;
        $('mfa-qr').src = data.qrCode;
        $('mfa-account').textContent = FinanceSession.currentUser().email;
        $('mfa-enrollment').hidden = false;
      } else {
        mfaPending = false;
        clearEnrollment();
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
    await loadTickets();
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
    $('support-grants').innerHTML = data.grants.length ? `<table><thead><tr><th>Access</th><th>Expires</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>${
      data.grants.map(grant => `<tr><td>${grant.accessLevel === 'write' ? 'View &amp; edit' : 'View only'}</td><td>${escape(when(grant.expiresAt))}</td><td>${escape(when(grant.lastUsedAt))}</td>
        <td>${grant.active ? '<span class="pill">Active</span>' : grant.revokedAt ? 'Revoked' : 'Expired'}</td>
        <td>${grant.active ? `<button class="btn btn-secondary" data-revoke="${Number(grant.id)}">Revoke now</button>` : ''}</td></tr>`).join('')
    }</tbody></table>` : '<p class="muted">You have not granted support access.</p>';
    $('support-activity').innerHTML = data.activity.length ? `<table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Result</th></tr></thead><tbody>${
      data.activity.map(row => `<tr><td>${escape(when(row.created_at))}</td><td>${escape(row.actor_name || 'You')}</td>
        <td>${escape(row.event_type === 'support.request' ? `${row.method} ${row.path}` : row.event_type.replace('support.', '').replaceAll('_', ' '))}</td>
        <td>${escape(row.status ? (row.status < 400 ? 'Allowed' : `Blocked (${row.status})`) : row.outcome)}</td></tr>`).join('')
    }</tbody></table>` : '<p class="muted">No support activity yet.</p>';
  }

  let ticketGeneration = 0;
  let ticketLoadGeneration = 0;
  const canOpenTickets = () => !FinanceSession.currentSupport()
    && FinanceSession.currentUser?.()?.email?.toLowerCase() !== 'demo@myfinance.app';
  window.FinanceSupportTickets = { reset() {
    ticketGeneration++;
    $('support-ticket-history').textContent = '';
    $('support-ticket-status').textContent = '';
    $('support-ticket-description').value = '';
    $('support-ticket-category').value = '';
  } };
  async function ticketApi(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to complete the support request.');
    return data;
  }
  async function loadTickets() {
    const generation = ticketGeneration;
    const loadGeneration = ++ticketLoadGeneration;
    const allowed = canOpenTickets();
    $('support-ticket-form').hidden = !allowed;
    $('support-ticket-refresh').hidden = !allowed;
    if (!allowed) {
      $('support-ticket-history').innerHTML = '';
      $('support-ticket-status').textContent = 'Support cases are unavailable in demo or support sessions.';
      return;
    }
    try {
      const tickets = await ticketApi('/api/support-tickets');
      if (generation !== ticketGeneration || loadGeneration !== ticketLoadGeneration) return;
      const labels = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
      $('support-ticket-history').innerHTML = tickets.length ? `<ul class="support-ticket-list">${tickets.map(ticket =>
        `<li class="support-ticket-item">
          <div class="support-ticket-item-heading"><h4>${escape(ticket.number)}</h4><span class="support-ticket-badge">${escape(labels[ticket.status])}</span></div>
          <dl class="support-ticket-meta"><div><dt>Category</dt><dd>${escape(ticket.category || 'Not specified')}</dd></div>
            <div><dt>Opened</dt><dd>${escape(when(ticket.createdAt))}</dd></div><div><dt>Last updated</dt><dd>${escape(when(ticket.updatedAt))}</dd></div></dl>
          <details class="support-ticket-details"><summary>View description</summary><p>${escape(ticket.description)}</p></details>
          <section aria-label="Support updates"><h4>Updates from support</h4>${ticket.updates?.length ? ticket.updates.map(update =>
            `<p><strong>${escape(labels[update.status])} &middot; ${escape(when(update.at))}</strong><br><span style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(update.message)}</span></p>`).join('') : '<p class="muted">No support update yet.</p>'}</section>
          ${ticket.emailStatus !== 'sent' ? '<p class="support-ticket-notice">Email notification pending or failed; support can retry it. Your ticket is saved. Do not submit again.</p>' : ''}
        </li>`).join('')}</ul>`
        : '<p class="muted">You have no support tickets yet.</p>';
    } catch (error) {
      if (generation !== ticketGeneration || loadGeneration !== ticketLoadGeneration) return;
      $('support-ticket-status').textContent = `Unable to load tickets: ${error.message}`;
    }
  }
  async function createTicket() {
    if (!canOpenTickets()) return;
    const button = $('support-ticket-form').querySelector('button');
    button.disabled = true;
    const generation = ticketGeneration;
    try {
      const data = await ticketApi('/api/support-tickets', { method: 'POST', body: JSON.stringify({
        description: $('support-ticket-description').value.trim(), category: $('support-ticket-category').value.trim()
      }) });
      if (generation !== ticketGeneration) return;
      $('support-ticket-description').value = '';
      $('support-ticket-category').value = '';
      $('support-ticket-status').textContent = `Ticket ${data.ticket.number} opened. ${data.warning || 'Support has been notified by email. Track its status below.'}`;
      await loadTickets();
    } catch (error) {
      if (generation === ticketGeneration) $('support-ticket-status').textContent = error.message;
    } finally { button.disabled = false; }
  }

  view.addEventListener('submit', async event => {
    if (event.target.id === 'support-ticket-form') { event.preventDefault(); await createTicket(); return; }
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
        body: JSON.stringify({ accessLevel: level, hours: Number($('support-hours').value) }) });
      $('support-status').textContent = 'Access granted. Tell support it is ready; they will not see your password.';
      await loadSettings();
    } catch (error) { $('support-status').textContent = error.message; }
  });
  view.addEventListener('click', async event => {
    if (event.target.closest?.('#support-ticket-refresh')) {
      $('support-ticket-status').textContent = '';
      await loadTickets();
      return;
    }
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
