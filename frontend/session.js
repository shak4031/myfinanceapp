/* Session checks happen before any financial requests, including legacy views. */
window.FinanceSession = (() => {
  const nativeFetch = window.fetch.bind(window);
  let user = null;
  let support = null;
  let generation = 0;
  let mode = 'login';
  let registrationEnabled = false;
  let setupRequired = false;
  let cleanAppMarkup = '';
  let inviteToken = location.hash.startsWith('#invite-token=') ? location.hash.slice('#invite-token='.length) : '';
  let verifyToken = location.hash.startsWith('#verify-token=') ? location.hash.slice('#verify-token='.length) : '';
  let verificationNotice = '';
  if (inviteToken || verifyToken) history.replaceState(null, '', location.pathname);
  const el = id => document.getElementById(id);
  function lock() {
    user = null;
    support = null;
    generation++;
    window.FinanceSpendingHistory?.reset();
    window.FinanceImportHistory?.reset();
    window.FinanceReviewTools?.reset();
    window.FinanceAccounts?.reset();
    window.FinancePerformance?.clear();
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
      if (response.status === 402 && body.code === 'SUBSCRIPTION_REQUIRED') {
        if (body.entitlement) window.FinancePro?.setEntitlement(body.entitlement);
        window.showView?.('subscription');
      }
      throw Object.assign(new Error(body.error || `Request failed (${response.status})`), { status: response.status, code: body.code, entitlement: body.entitlement });
    }
    const method = String(options.method || resource?.method || 'GET').toUpperCase();
    if (!auth && response.ok && !['GET', 'HEAD', 'OPTIONS'].includes(method)
      && /^\/api\/(?:transactions|categories|categorizations|import|bulk-import|staging|accounts|debts|goals|analytics|plan)(?:\/|$)/.test(url.pathname)) {
      window.FinancePro?.invalidateAnalytics?.();
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
    el('auth-screen').classList.toggle('is-registering', mode === 'register');
    el('auth-signup-steps').hidden = mode !== 'register';
    el('auth-plan-options').hidden = mode !== 'register';
    for (const plan of ['basic', 'pro']) {
      el(`auth-plan-${plan}`).disabled = mode !== 'register';
      el(`auth-plan-${plan}`).required = mode === 'register';
    }
    el('auth-form').hidden = false;
    el('auth-title').textContent = ['invite', 'accept'].includes(mode) ? 'Join your household.' : mode === 'setup' ? 'Your fresh start begins here.' : mode === 'register' ? 'Make room for your next chapter.'
      : mode === 'forgot' ? 'Reset your password.' : mode === 'reset' ? 'Choose a new password.' : 'Welcome back.';
    el('auth-description').textContent = mode === 'setup' ? 'Create the owner account using the setup token from your server administrator.'
      : mode === 'forgot' ? 'Enter your account email. If it matches an account, we will email a reset link that expires in 30 minutes.'
      : mode === 'reset' ? 'Use at least 12 characters. All existing sessions will be signed out.'
      : 'Sign in to your private financial workspace.';
    el('auth-name-label').hidden = ['login', 'accept'].includes(mode) || recovery;
    el('auth-name').required = !['login', 'accept', 'forgot', 'reset'].includes(mode);
    el('auth-email-label').hidden = ['reset', 'accept'].includes(mode);
    el('auth-email').required = !['reset', 'accept'].includes(mode);
    el('auth-password-label').hidden = ['forgot', 'accept'].includes(mode);
    el('auth-password').required = !['forgot', 'accept'].includes(mode);
    el('auth-token-label').hidden = mode !== 'setup';
    el('auth-token').required = mode === 'setup';
    el('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    el('auth-password').minLength = mode === 'login' ? 1 : 12;
    el('auth-submit').textContent = mode === 'accept' ? 'Join invited household' : mode === 'invite' ? 'Create login and join household' : mode === 'setup' ? 'Create owner account' : mode === 'register' ? 'Create account & verify email'
      : mode === 'forgot' ? 'Email me a reset link' : mode === 'reset' ? 'Save new password' : 'Sign in';
    el('auth-switch').hidden = inviteToken || recovery || mode === 'setup' ? false : !registrationEnabled;
    el('auth-switch').textContent = mode === 'accept' ? 'Keep my current household' : mode === 'invite' ? 'Already have an account? Sign in to join' : inviteToken && mode === 'login' ? 'Create a login for this invitation' : recovery || mode === 'setup' ? 'Back to sign in' : mode === 'register' ? 'Already have an account? Sign in' : 'Create an account';
    if (mode === 'register') el('auth-description').textContent = 'Choose your household plan and create your login below. Next, verify your email and add payment details in Stripe Checkout to start your 15-day Pro trial. No subscription starts when you create this account.';
    if (mode === 'invite') el('auth-description').textContent = 'Create your own login to edit your household’s shared finances. The household owner manages billing and members.';
    if (mode === 'accept') el('auth-description').textContent = 'Join with your existing login to edit the invited household’s shared finances. You can join only if your current household has no financial data or paid access. The invited household’s owner manages billing and membership.';
    el('auth-forgot').hidden = mode !== 'login';
    // The owner token is only for the very first run, and only once someone asks for it.
    const setupLink = el('auth-setup');
    if (setupLink) setupLink.hidden = !setupRequired || mode !== 'login';
    renderPlanChoice();
    if (verificationNotice) el('auth-error').textContent = verificationNotice;
  }

  // Plan picked on the public pricing cards; survives the post-sign-in reload until it is submitted.
  const PLAN_KEY = 'myfinance.chosenPlan';
  const PLANS = {
    basic: { name: 'Basic', price: 'USD 9.99 / month per household', note: 'Core finances for your household. Continue after sign-in to select your plan and provide payment details in Stripe hosted Checkout.' },
    pro: { name: 'Pro', price: 'USD 14.99 / month per household', note: 'All analytics, budgets, debt planning and goals. Continue after sign-in to Stripe hosted Checkout. The 15-day trial includes all Pro features and auto-charges your selected plan unless cancelled.' }
  };
  let chosenPlan = '';
  const store = {
    get() { try { const plan = globalThis.localStorage?.getItem(PLAN_KEY); return PLANS[plan] ? plan : chosenPlan; } catch { return chosenPlan; } },
    set(plan) { chosenPlan = PLANS[plan] ? plan : ''; try { chosenPlan ? globalThis.localStorage?.setItem(PLAN_KEY, chosenPlan) : globalThis.localStorage?.removeItem(PLAN_KEY); } catch { /* private mode: the signup redirect retains the plan */ } }
  };
  function renderPlanChoice() {
    const chosen = store.get();
    for (const plan of ['basic', 'pro']) el(`auth-plan-${plan}`).checked = chosen === plan;
    document.querySelectorAll('[data-choose-plan]').forEach(button => {
      const selected = button.dataset.choosePlan === chosen;
      button.setAttribute('aria-pressed', String(selected));
      button.textContent = selected ? `\u2713 ${PLANS[chosen].name} selected` : `Choose ${PLANS[button.dataset.choosePlan]?.name || ''}`;
      button.closest?.('.marketing-plan')?.classList.toggle('is-selected', selected);
    });
    const banner = el('auth-plan');
    if (!banner) return;
    banner.hidden = !chosen || ['register', 'forgot', 'reset', 'invite', 'accept'].includes(mode);
    if (!chosen) return;
    el('auth-plan-name').textContent = PLANS[chosen].name;
    el('auth-plan-price').textContent = PLANS[chosen].price;
    el('auth-plan-note').textContent = PLANS[chosen].note;
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
    const focusAccess = () => {
      if (registrationEnabled && mode === 'login') { mode = 'register'; renderMode(); }
      (el('marketing-signin') || el('marketing-access'))?.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      (mode === 'setup' || mode === 'register' ? el('auth-name') : el('auth-email'))?.focus({ preventScroll: true });
    };
    el('marketing-start')?.addEventListener('click', focusAccess);
    document.querySelectorAll('[data-marketing-start]').forEach(button => button.addEventListener('click', focusAccess));
    document.querySelectorAll('[data-choose-plan]').forEach(button => button.addEventListener('click', () => {
      store.set(button.dataset.choosePlan);
      renderPlanChoice();
      focusAccess();
    }));
    el('auth-plan-clear')?.addEventListener('click', () => { store.set(''); renderPlanChoice(); });
    for (const plan of ['basic', 'pro']) {
      el(`auth-plan-${plan}`).addEventListener('change', event => {
        if (event.target.checked) { store.set(plan); renderPlanChoice(); }
      });
    }
    el('auth-switch').onclick = () => {
      if (mode === 'accept') { inviteToken = ''; location.reload(); return; }
      mode = mode === 'login' ? (inviteToken ? 'invite' : registrationEnabled ? 'register' : 'login') : 'login';
      if (location.hash.startsWith('#reset-token=')) history.replaceState(null, '', location.pathname);
      el('auth-error').textContent = '';
      renderMode();
    };
    el('auth-forgot').onclick = () => { mode = 'forgot'; el('auth-error').textContent = ''; renderMode(); };
    const setupLink = el('auth-setup');
    if (setupLink) setupLink.onclick = () => { mode = 'setup'; el('auth-error').textContent = ''; renderMode(); el('auth-name')?.focus?.(); };
    el('auth-form').onsubmit = async event => {
      event.preventDefault();
      el('auth-submit').disabled = true;
      el('auth-error').textContent = '';
      try {
        const signupPlan = mode === 'register' ? ['basic', 'pro'].find(plan => el(`auth-plan-${plan}`).checked) : '';
        if (mode === 'register' && !signupPlan) throw new Error('Choose Basic or Pro before creating your account.');
        if (signupPlan) store.set(signupPlan);
        if (mode === 'accept') {
          const accepted = await fetch('/api/household/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: inviteToken }) });
          const result = await accepted.json();
          if (!accepted.ok) throw new Error(result.error || 'Unable to join the household.');
          inviteToken = '';
          if (result.signInRequired) {
            mode = 'login';
            lock();
          }
          location.reload();
          return;
        }
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
        const response = await fetch(`/api/auth/${mode === 'invite' ? 'accept-invite' : mode}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: el('auth-email').value.trim(), password: el('auth-password').value, name: el('auth-name').value.trim(), setupToken: el('auth-token').value, ...(inviteToken && mode === 'invite' ? { token: inviteToken } : {}) })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to sign in.');
        if (inviteToken && mode === 'login') {
          user = data.user || (await (await fetch('/api/auth/me')).json()).user;
          if (!user) throw new Error('Unable to verify the signed-in account.');
          mode = 'accept';
          renderMode();
          return;
        }
        inviteToken = '';
        if (signupPlan) location.hash = `#subscription/${signupPlan}`;
        location.reload();
      } catch (error) { el('auth-error').textContent = error.message; }
      finally { el('auth-submit').disabled = false; }
    };
    if (verifyToken) {
      try {
        const verification = await fetch('/api/auth/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: verifyToken }) });
        const result = await verification.json();
        if (!verification.ok) throw new Error(result.error || 'Unable to verify your email.');
        verificationNotice = 'Email verified. Continue to your household setup.';
      } catch (error) { verificationNotice = error.message; }
      finally { verifyToken = ''; }
    }
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
        if (inviteToken) {
          mode = 'accept';
          renderMode();
          return;
        }
        el('account-name').textContent = user.name || user.email;
        if (support) showSupportBanner(support);
        const admin = user.role === 'admin' && !support;
        document.body.classList.toggle('is-admin', admin);
        const adminLink = el('nav-admin-item');
        if (adminLink) adminLink.hidden = !admin;
        document.body.classList.remove('auth-pending');
        const target = location.hash.slice(1);
        await showView(['categories','category-admin','transactions','transaction-review','activity','accounts','analytics','knowledge-base','etl','payoff','goals','insights','tutorials','settings','subscription'].includes(target.split('/')[0]) ? target : 'dashboard');
        if (verificationNotice) globalThis.notify?.(verificationNotice);
        return;
      }
      if (response.status !== 401) throw new Error('Unable to check your session.');
      const statusResponse = await fetch('/api/auth/status');
      if (!statusResponse.ok) throw new Error('Account service unavailable. Please reload to retry.');
      const status = await statusResponse.json();
      setupRequired = !!status.setupRequired;
      mode = inviteToken ? 'invite' : setupRequired && location.hash === '#owner-setup' ? 'setup' : 'login';
      registrationEnabled = !!status.registrationEnabled;
      renderMode();
    } catch (error) { el('auth-description').textContent = error.message; }
  }
  async function logout() {
    if (window.FinanceSessionGuard) window.FinanceSessionGuard.end();
    else lock();
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Your financial data is hidden, but server sign-out failed. Reconnect and sign out again.');
      location.reload();
    } catch (error) {
      el('auth-description').textContent = `Your financial data is hidden. Server sign-out could not be confirmed: ${error.message}`;
    }
  }
  window.FinanceSessionGuard?.configure(message => {
    lock();
    el('auth-description').textContent = message;
  });
  return { start, logout, isAuthenticated: () => !!user, currentUser: () => user, currentSupport: () => support, chosenPlan: () => store.get() };
})();
