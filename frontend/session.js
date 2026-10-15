/* Session checks happen before any financial requests, including legacy views. */
window.FinanceSession = (() => {
  const nativeFetch = window.fetch.bind(window);
  let user = null;
  let support = null;
  let generation = 0;
  let mode = 'login';
  let registrationEnabled = false;
  let cleanAppMarkup = '';
  const el = id => document.getElementById(id);
  function lock() {
    user = null;
    support = null;
    generation++;
    document.body.classList.add('auth-pending');
    if (cleanAppMarkup) document.querySelector('.app-container').innerHTML = cleanAppMarkup;
    document.querySelectorAll('#toasts, #csv-file-list, #pdf-file-list, #import-result').forEach(node => { node.textContent = ''; });
    document.querySelectorAll('dialog[open]').forEach(node => node.close());
    document.querySelectorAll('input:not(#auth-email), textarea').forEach(node => { node.value = ''; });
    if (typeof cashflowDataCache !== 'undefined') cashflowDataCache = null;
    if (typeof pendingCsvFile !== 'undefined') pendingCsvFile = null;
    if (typeof pendingPdfFile !== 'undefined') pendingPdfFile = null;
    if (window.clearFinanceState) window.clearFinanceState();
    renderMode();
  }
  window.fetch = async (resource, options = {}) => {
    const url = new URL(typeof resource === 'string' ? resource : resource.url, location.href);
    if (url.origin !== location.origin) throw new Error('Only same-origin requests are allowed.');
    const auth = url.pathname.startsWith('/api/auth/');
    if (!auth && url.pathname.startsWith('/api/') && !user) throw new Error('Please sign in.');
    const requestGeneration = generation;
    const response = await nativeFetch(resource, { ...options, credentials: 'same-origin' });
    if (!auth && response.status === 401) { lock(); throw new Error('Your session ended. Please sign in again.'); }
    if (!auth && requestGeneration !== generation) throw new Error('Session changed. Request discarded.');
    if (!auth && !response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    if (!auth) {
      const parse = response.json.bind(response);
      response.json = async () => {
        const body = await parse();
        if (requestGeneration !== generation || !user) throw new Error('Session changed. Response discarded.');
        return body;
      };
    }
    return response;
  };
  function renderMode() {
    const recovery = mode === 'forgot' || mode === 'reset';
    el('auth-form').hidden = false;
    el('auth-title').textContent = mode === 'setup' ? 'Your fresh start begins here.' : mode === 'register' ? 'Make room for your next chapter.'
      : mode === 'forgot' ? 'Reset your password.' : mode === 'reset' ? 'Choose a new password.' : 'Welcome back.';
    el('auth-description').textContent = mode === 'setup' ? 'Create the owner account using the setup token from your server administrator.'
      : mode === 'forgot' ? 'Enter your account email. If it matches an account, we will email a reset link that expires in 30 minutes.'
      : mode === 'reset' ? 'Use at least 12 characters. All existing sessions will be signed out.'
      : 'Sign in to your private financial workspace.';
    el('auth-name-label').hidden = mode === 'login' || recovery;
    el('auth-name').required = !['login', 'forgot', 'reset'].includes(mode);
    el('auth-email-label').hidden = mode === 'reset';
    el('auth-email').required = mode !== 'reset';
    el('auth-password-label').hidden = mode === 'forgot';
    el('auth-password').required = mode !== 'forgot';
    el('auth-token-label').hidden = mode !== 'setup';
    el('auth-token').required = mode === 'setup';
    el('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    el('auth-password').minLength = mode === 'login' ? 1 : 12;
    el('auth-submit').textContent = mode === 'setup' ? 'Create owner account' : mode === 'register' ? 'Create account'
      : mode === 'forgot' ? 'Email me a reset link' : mode === 'reset' ? 'Save new password' : 'Sign in';
    el('auth-switch').hidden = recovery ? false : !registrationEnabled || mode === 'setup';
    el('auth-switch').textContent = recovery ? 'Back to sign in' : mode === 'register' ? 'Already have an account? Sign in' : 'Create an account';
    el('auth-forgot').hidden = mode !== 'login';
  }
  function showSupportBanner(support) {
    const banner = document.createElement('div');
    banner.className = 'support-banner';
    banner.setAttribute('role', 'status');
    const access = support.accessLevel === 'write' ? 'read and edit access' : 'read-only access';
    const until = new Date(support.expiresAt).toLocaleString();
    banner.innerHTML = '<span></span><button class="btn btn-secondary" type="button">End support session</button>';
    banner.querySelector('span').textContent = `Support session: ${support.actor.name} is viewing ${user.name}'s account with ${access} (granted by the customer, expires ${until}). Every action is logged.`;
    banner.querySelector('button').onclick = async () => {
      await nativeFetch('/api/auth/end-support', { method: 'POST', credentials: 'same-origin' });
      location.href = '/admin.html';
    };
    document.body.prepend(banner);
    document.body.classList.add('support-mode');
  }
  async function start() {
    cleanAppMarkup = document.querySelector('.app-container').innerHTML;
    el('auth-switch').onclick = () => {
      mode = mode === 'login' ? 'register' : 'login';
      if (location.hash.startsWith('#reset-token=')) history.replaceState(null, '', location.pathname);
      el('auth-error').textContent = '';
      renderMode();
    };
    el('auth-forgot').onclick = () => { mode = 'forgot'; el('auth-error').textContent = ''; renderMode(); };
    el('auth-form').onsubmit = async event => {
      event.preventDefault();
      el('auth-submit').disabled = true;
      el('auth-error').textContent = '';
      try {
        if (mode === 'forgot' || mode === 'reset') {
          const resetToken = location.hash.slice('#reset-token='.length);
          const response = await fetch(`/api/auth/password-reset/${mode === 'forgot' ? 'request' : 'confirm'}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mode === 'forgot' ? { email: el('auth-email').value.trim() } : { token: resetToken, password: el('auth-password').value })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Unable to reset the password.');
          el('auth-password').value = '';
          if (mode === 'reset') history.replaceState(null, '', location.pathname);
          mode = 'login';
          renderMode();
          el('auth-description').textContent = data.message;
          return;
        }
        const response = await fetch(`/api/auth/${mode}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: el('auth-email').value.trim(), password: el('auth-password').value, name: el('auth-name').value.trim(), setupToken: el('auth-token').value })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to sign in.');
        location.reload();
      } catch (error) { el('auth-error').textContent = error.message; }
      finally { el('auth-submit').disabled = false; }
    };
    try {
      if (location.hash.startsWith('#reset-token=')) {
        mode = 'reset';
        renderMode();
        return;
      }
      const response = await fetch('/api/auth/me');
      if (response.ok) {
        const data = await response.json();
        if (!data.user) throw new Error('Invalid session response.');
        user = data.user;
        support = data.support || null;
        el('account-name').textContent = user.name || user.email;
        if (support) showSupportBanner(support);
        document.body.classList.toggle('is-admin', user.role === 'admin' && !support);
        document.body.classList.remove('auth-pending');
        const target = location.hash.slice(1);
        showView(['categories','transactions','etl','payoff','goals','insights','settings'].includes(target) ? target : 'dashboard');
        return;
      }
      if (response.status !== 401) throw new Error('Unable to check your session.');
      const statusResponse = await fetch('/api/auth/status');
      if (!statusResponse.ok) throw new Error('Account service unavailable. Please reload to retry.');
      const status = await statusResponse.json();
      mode = status.setupRequired ? 'setup' : 'login';
      registrationEnabled = !!status.registrationEnabled;
      renderMode();
    } catch (error) { el('auth-description').textContent = error.message; }
  }
  async function logout() {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Sign out failed. Please retry.');
      lock();
      location.reload();
    } catch (error) { if (window.notify) notify(error.message); }
  }
  return { start, logout, isAuthenticated: () => !!user, currentUser: () => user, currentSupport: () => support };
})();
