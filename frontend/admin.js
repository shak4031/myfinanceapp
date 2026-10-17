/* Admin console: operations, audit search, account recovery, consented support sessions, API explorer. */
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const when = value => value ? new Date(value).toLocaleString() : '—';
  let oldestAuditId = null;

  function toast(message) {
    const node = $('admin-toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.hidden = true; }, 6000);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) {
      const requestId = response.headers.get('x-request-id');
      throw new Error(`${body?.error || `Request failed (${response.status})`}${requestId ? ` · request ${requestId}` : ''}`);
    }
    return body;
  }

  // Tabs
  $('tabs').addEventListener('click', event => {
    const tab = event.target.dataset.tab;
    if (!tab) return;
    document.querySelectorAll('#tabs button').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
    document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== tab; });
    loaders[tab]?.().catch(error => toast(error.message));
  });
  const openTab = tab => document.querySelector(`#tabs button[data-tab="${tab}"]`).click();

  async function loadOverview() {
    const data = await api('/api/admin/overview');
    const s = data.stats;
    const stat = (label, value, bad) => `<div class="stat ${bad ? 'bad' : ''}"><span class="eyebrow">${esc(label)}</span><b>${esc(value)}</b></div>`;
    const warnings = [
      !data.emailConfigured && 'Email (SMTP) is not configured, so customers cannot receive password reset links. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM.',
      !data.alertWebhookConfigured && 'No ALERT_WEBHOOK_URL is set, so server errors and lockouts are logged but nobody is notified.'
    ].filter(Boolean);
    $('overview').innerHTML = `${warnings.map(text => `<div class="warn">${esc(text)}</div>`).join('')}
      <div class="stats">
        ${stat('Status', data.status)}${stat('Database latency', `${data.databaseLatencyMs} ms`, data.databaseLatencyMs > 500)}
        ${stat('Accounts', s.users)}${stat('Active sessions', s.active_sessions)}
        ${stat('Failed logins (24h)', s.failed_logins_24h, s.failed_logins_24h > 20)}${stat('Lockouts (24h)', s.lockouts_24h, s.lockouts_24h > 0)}
        ${stat('Server errors (24h)', s.server_errors_24h, s.server_errors_24h > 0)}
        ${stat('Browser errors (24h)', s.browser_errors_24h, s.browser_errors_24h > 0)}
        ${stat('Active support grants', s.active_support_grants)}
      </div>
      <div class="card" style="margin-top:16px"><table><tbody>
        <tr><th>Environment</th><td>${esc(data.environment)}</td></tr><tr><th>Node</th><td>${esc(data.node)}</td></tr>
        <tr><th>Uptime</th><td>${esc(Math.round(data.uptimeSeconds / 60))} minutes</td></tr>
        <tr><th>Public registration</th><td>${data.registrationEnabled ? 'Open' : 'Closed'}</td></tr>
        <tr><th>Audit retention</th><td>${esc(data.auditRetentionDays)} days</td></tr>
      </tbody></table>
      <div class="actions" style="margin-top:12px">
        <button class="btn btn-secondary" data-error-jump>View error logs</button>
        <button class="btn btn-secondary" data-jump="auth.login">View failed logins</button>
      </div></div>`;
  }
  $('overview').addEventListener('click', event => {
    if (event.target.dataset.errorJump !== undefined) {
      $('errors-range').value = '24h';
      $('errors-request').value = '';
      return openTab('errors');
    }
    const type = event.target.dataset.jump;
    if (!type) return;
    $('f-type').value = type;
    $('f-outcome').value = type === 'auth.login' ? 'failure' : '';
    openTab('audit');
  });

  function planCell(user) {
    const license = user.license || { tier: 'free' };
    const detail = license.tier === 'trial' ? `Trial · ${license.daysLeft}d left` : license.source === 'owner' ? 'Pro · owner' : license.source === 'demo' ? 'Pro · demo' : license.tier === 'pro' ? 'Pro' : license.source === 'trial-expired' ? 'Free · trial used' : 'Free';
    return `<span class="plan-pill is-${esc(license.tier)}">${esc(detail)}</span>`;
  }
  function planButton(user) {
    const license = user.license || { tier: 'free' };
    if (license.source === 'owner' || license.source === 'demo') return '';
    return license.tier === 'pro'
      ? `<button class="btn btn-secondary" data-action="license-revoke" data-id="${esc(user.id)}" data-email="${esc(user.email)}">Revoke Pro</button>`
      : `<button class="btn btn-primary" data-action="license-grant" data-id="${esc(user.id)}" data-email="${esc(user.email)}">Grant Pro</button>`;
  }
  async function loadUsers() {
    const rows = await api(`/api/admin/users?q=${encodeURIComponent($('user-q').value.trim())}`);
    $('users').innerHTML = `<table><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Role</th><th>Plan</th><th>Last sign-in</th><th>Failed (24h)</th><th>Sessions</th><th>Grants</th><th>Actions</th></tr></thead><tbody>${
      rows.map(user => `<tr><td>${esc(user.id)}</td><td>${esc(user.name)}</td><td>${esc(user.email)}</td><td>${esc(user.role)}</td><td>${planCell(user)}</td>
        <td>${esc(when(user.last_login))}</td><td>${esc(user.failed_logins_24h)}</td><td>${esc(user.active_sessions)}</td><td>${esc(user.active_grants)}</td>
        <td class="actions">
          ${planButton(user)}
          <button class="btn btn-secondary" data-action="password-reset" data-id="${esc(user.id)}" data-email="${esc(user.email)}">Email reset link</button>
          <button class="btn btn-secondary" data-action="unlock" data-id="${esc(user.id)}">Unlock</button>
          <button class="btn btn-secondary" data-action="revoke-sessions" data-id="${esc(user.id)}">Sign out everywhere</button>
          <button class="btn btn-secondary" data-action="audit" data-id="${esc(user.id)}">Activity</button>
        </td></tr>`).join('')
    }</tbody></table>`;
  }
  $('user-search').onclick = () => loadUsers().catch(error => toast(error.message));
  $('users').addEventListener('click', async event => {
    const { action, id, email } = event.target.dataset;
    if (!action) return;
    if (action === 'audit') { $('f-user').value = id; $('f-type').value = ''; $('f-outcome').value = ''; return openTab('audit'); }
    const prompts = {
      'password-reset': `Email a password reset link to ${email}? Verify the customer's identity first. You will not see the link.`,
      'revoke-sessions': 'Sign this user out of every device?',
      unlock: 'Clear failed sign-in lockouts for this user?',
      'license-grant': `Grant MyFinance Pro ($4.99/month) to ${email}? Analytics, budgets and exports unlock immediately.`,
      'license-revoke': `Revoke MyFinance Pro from ${email}? Their budgets are kept but Pro features will be locked.`
    };
    if (!await FinanceUI.confirm(prompts[action])) return;
    try {
      const license = action.startsWith('license-');
      const result = await api(`/api/admin/users/${encodeURIComponent(id)}/${license ? 'license' : action}`, { method: 'POST', body: JSON.stringify(license ? { action: action.slice(8) } : {}) });
      toast(license ? `MyFinance Pro ${action === 'license-grant' ? 'granted' : 'revoked'}. The change was recorded in the audit log.` : result.message || 'Done. The action was recorded in the audit log.');
      await loadUsers();
    } catch (error) { toast(error.message); }
  });

  function auditQuery(beforeId) {
    const params = new URLSearchParams();
    const add = (key, value) => { if (value) params.set(key, value); };
    add('eventType', $('f-type').value); add('outcome', $('f-outcome').value); add('email', $('f-email').value.trim());
    add('userId', $('f-user').value); add('requestId', $('f-request').value.trim()); add('beforeId', beforeId); params.set('limit', '100');
    return `/api/admin/audit?${params}`;
  }
  const auditRow = row => `<tr><td>${esc(when(row.created_at))}</td><td><code>${esc(row.event_type)}</code></td>
    <td class="outcome-${esc(row.outcome)}">${esc(row.outcome)}</td>
    <td>${esc(row.actor_email || row.actor_user_id || '—')}</td><td>${esc(row.subject_email || row.subject_user_id || '—')}</td>
    <td>${esc(row.method || '')} ${esc(row.path || '')}${row.status ? ` → ${esc(row.status)}` : ''}</td>
    <td><code>${esc(row.request_id || '')}</code><br><small>ip ${esc(row.ip_ref || '—')}${row.support_grant_id ? ` · grant ${esc(row.support_grant_id)}` : ''}</small></td>
    <td><code>${esc(Object.keys(row.detail || {}).length ? JSON.stringify(row.detail) : '')}</code></td></tr>`;
  async function loadAudit(append = false) {
    const rows = await api(auditQuery(append ? oldestAuditId : null));
    const body = rows.map(auditRow).join('');
    if (!append) {
      $('audit').innerHTML = `<table><thead><tr><th>When</th><th>Event</th><th>Outcome</th><th>Actor</th><th>Account</th><th>Request</th><th>Request ID</th><th>Detail</th></tr></thead><tbody id="audit-rows">${body}</tbody></table>`;
    } else {
      $('audit-rows').insertAdjacentHTML('beforeend', body);
    }
    if (rows.length) oldestAuditId = rows[rows.length - 1].id;
    $('audit-more').hidden = rows.length < 100;
    if (!append && !rows.length) $('audit').innerHTML = '<p class="muted">No matching events.</p>';
  }
  $('audit-search').onclick = () => loadAudit().catch(error => toast(error.message));
  $('audit-more').onclick = () => loadAudit(true).catch(error => toast(error.message));

  async function loadErrorLogs() {
    $('errors').innerHTML = '<p class="muted">Loading error logs…</p>';
    const params = new URLSearchParams({ range: $('errors-range').value });
    const requestId = $('errors-request').value.trim();
    if (requestId) params.set('requestId', requestId);
    const rows = await api(`/api/admin/errors?${params}`);
    $('errors').innerHTML = rows.length ? `<table><thead><tr><th>When</th><th>Source</th><th>Route</th><th>Summary</th><th>Request ID</th><th>Account</th></tr></thead><tbody>${
      rows.map(row => {
        const detail = row.detail || {};
        const source = detail.source === 'browser' ? 'Browser' : 'Server';
        const summary = [detail.name, detail.message].filter(Boolean).join(': ') || 'No error summary recorded';
        const location = detail.file ? `${detail.file}${detail.line ? `:${detail.line}` : ''}` : '';
        return `<tr><td>${esc(when(row.created_at))}</td><td class="severity-${source.toLowerCase()}">${source}</td>
          <td>${esc(row.method || '')} ${esc(row.path || '')}${row.status ? ` → ${esc(row.status)}` : ''}<br><small>${esc(location)}</small></td>
          <td>${esc(summary)}${detail.code ? `<br><small>Code: ${esc(detail.code)}</small>` : ''}</td>
          <td><code>${esc(row.request_id || '—')}</code></td><td>${esc(row.actor_email || row.actor_user_id || '—')}</td></tr>`;
      }).join('')
    }</tbody></table>` : '<p class="muted">No errors found for this range and request ID.</p>';
  }
  $('errors-search').onclick = () => loadErrorLogs().catch(error => {
    $('errors').innerHTML = `<p class="outcome-error">${esc(error.message)}</p>`;
  });

  async function loadGrants() {
    const rows = await api('/api/admin/support-grants');
    $('grants').innerHTML = rows.length ? `<table><thead><tr><th>Customer</th><th>Reason</th><th>Access</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>${
      rows.map(grant => `<tr><td>${esc(grant.name)}<br><small>${esc(grant.email)}</small></td><td>${esc(grant.reason)}</td>
        <td>${grant.access_level === 'write' ? 'View &amp; edit' : 'View only'}</td><td>${esc(when(grant.expires_at))}</td><td>${esc(when(grant.last_used_at))}</td>
        <td><button class="btn btn-primary" data-grant="${esc(grant.id)}">Start support session</button></td></tr>`).join('')
    }</tbody></table>` : '<p class="muted">No customer has granted access right now. Ask them to open Settings &amp; support and choose “Grant access”.</p>';
  }
  $('grants').addEventListener('click', async event => {
    const grantId = Number(event.target.dataset.grant);
    if (!grantId) return;
    try {
      await api('/api/admin/support-sessions', { method: 'POST', body: JSON.stringify({ grantId }) });
      location.href = '/';
    } catch (error) { toast(error.message); }
  });

  async function loadApi() {
    if ($('api').dataset.loaded) return;
    const spec = await api('/api/admin/openapi.json');
    const groups = {};
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) (groups[op.tags[0]] ||= []).push({ path, method, op });
    }
    $('api').innerHTML = `<div class="card"><h2>${esc(spec.info.title)} <small class="muted">v${esc(spec.info.version)}</small></h2><p class="muted">${esc(spec.info.description)}</p></div>` +
      Object.entries(groups).map(([tag, ops]) => `<h3>${esc(tag)}</h3>${ops.map((entry, index) => {
        const params = entry.op.parameters || [];
        const example = entry.op.requestBody?.content?.['application/json']?.example;
        return `<details class="op" data-path="${esc(entry.path)}" data-method="${esc(entry.method)}">
          <summary><span class="method ${esc(entry.method)}">${esc(entry.method.toUpperCase())}</span><code>${esc(entry.path)}</code><span class="muted" style="margin:0">${esc(entry.op.summary)}</span></summary>
          <div class="op-body">
            ${params.map(param => `<label>${esc(param.name)} <small>(${esc(param.in)})</small><input data-param="${esc(param.name)}" data-in="${esc(param.in)}"></label>`).join('')}
            ${['post', 'put', 'patch'].includes(entry.method) ? `<label>JSON body<textarea data-body>${esc(JSON.stringify(example ?? {}, null, 2))}</textarea></label>` : ''}
            <div class="actions"><button class="btn btn-primary" data-send>Send request</button></div>
            <pre data-result hidden></pre>
          </div></details>`;
      }).join('')}`).join('');
    $('api').dataset.loaded = 'true';
  }
  $('api').addEventListener('click', async event => {
    if (!event.target.matches('[data-send]')) return;
    const op = event.target.closest('details.op');
    let path = op.dataset.path;
    const query = new URLSearchParams();
    for (const input of op.querySelectorAll('[data-param]')) {
      if (input.dataset.in === 'path') path = path.replace(`{${input.dataset.param}}`, encodeURIComponent(input.value));
      else if (input.value) query.set(input.dataset.param, input.value);
    }
    const bodyInput = op.querySelector('[data-body]');
    const output = op.querySelector('[data-result]');
    output.hidden = false;
    try {
      if (bodyInput) JSON.parse(bodyInput.value || '{}');
      const started = performance.now();
      const response = await fetch(`${path}${query.toString() ? `?${query}` : ''}`, {
        method: op.dataset.method.toUpperCase(), credentials: 'same-origin',
        headers: bodyInput ? { 'Content-Type': 'application/json' } : undefined, body: bodyInput ? bodyInput.value || '{}' : undefined
      });
      const text = await response.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
      output.textContent = `${response.status} ${response.statusText} · ${Math.round(performance.now() - started)} ms · request ${response.headers.get('x-request-id') || 'n/a'}\n\n${pretty}`;
    } catch (error) { output.textContent = `Request not sent: ${error.message}`; }
  });

  const loaders = { overview: loadOverview, users: loadUsers, errors: loadErrorLogs, audit: () => loadAudit(), support: loadGrants, api: loadApi };

  (async () => {
    try {
      const me = await api('/api/auth/me');
      if (me.support) {
        $('admin-who').textContent = 'You are in a support session. End it to use the admin console.';
        const button = document.createElement('button');
        button.className = 'btn btn-primary';
        button.textContent = 'End support session';
        button.onclick = async () => { await fetch('/api/auth/end-support', { method: 'POST', credentials: 'same-origin' }); location.reload(); };
        $('admin-who').after(button);
        return;
      }
      if (me.user.role !== 'admin') throw new Error('not admin');
      $('admin-who').textContent = `Signed in as ${me.user.name} (${me.user.email}). Admin actions are audited.`;
      $('admin-app').hidden = false;
      await loadOverview();
    } catch {
      $('admin-who').textContent = '';
      $('admin-denied').hidden = false;
    }
  })();
})();
