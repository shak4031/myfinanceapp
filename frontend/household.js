/* Household subscription onboarding and owner-managed membership. */
(() => {
  const $ = id => document.getElementById(id);
  const pro = () => window.FinancePro;
  const esc = value => pro().format.esc(value);
  const request = (url, options) => pro().request(url, options);
  const post = (url, body = {}) => request(url, { method: 'POST', body: JSON.stringify(body) });
  const support = () => !!window.FinanceSession?.currentSupport?.();
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not available';
  let routeGeneration = 0;
  function external(url) {
    const target = new URL(url, location.href);
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Billing returned an invalid secure redirect.');
    location.assign(target.href);
  }
  function billingMarkup(data, reason = '', selected = 'pro') {
    const entitlement = data.entitlement || {};
    const subscription = data.subscription;
    const managedSubscription = subscription && !['canceled', 'incomplete_expired'].includes(subscription.status);
    const owner = data.owner && !support();
    const verificationRequired = window.FinanceSession?.currentUser?.()?.emailVerified === false;
    return `${!entitlement.active && owner ? `<ol class="household-setup-steps" aria-label="Account setup progress"><li>1. Account created</li><li${verificationRequired ? ' aria-current="step"' : ''}>2. ${verificationRequired ? 'Verify email' : 'Email verified'}</li><li${!verificationRequired ? ' aria-current="step"' : ''}>3. Secure checkout</li></ol>` : ''}
      <h2 id="household-billing-title">${!entitlement.active && owner ? verificationRequired ? 'Verify your email to continue' : 'Finish setting up your household' : 'Your household plan'}</h2>
      ${reason ? `<p>${esc(reason)}</p>` : ''}
      <p>One subscription covers your household. Members can edit shared finances; only the owner manages billing and membership.</p>
      ${entitlement.active || subscription ? `<p><strong>${esc(pro().planLabel(entitlement).title)}</strong>${subscription ? ` · ${esc(subscription.status)}` : ''}</p>` : ''}
      ${subscription ? `<p>Selected renewal plan: <strong>${subscription.pending_change?.plan === 'basic' || subscription.plan === 'basic' ? 'Basic · USD 9.99/month' : subscription.plan === 'pro' ? 'Pro · USD 14.99/month' : esc(subscription.plan || 'Not available')}</strong>. ${subscription.cancel_at_period_end ? 'Access ends' : 'Current period ends'}: ${esc(date(subscription.current_period_end || subscription.trial_ends_at))}.</p>` : ''}
      ${entitlement.tier === 'trial' ? `<p>Your trial includes all Pro features until ${esc(date(entitlement.trialEndsAt || subscription?.trial_ends_at))}. ${subscription?.cancel_at_period_end ? 'Your trial stays active until then and will not renew.' : 'Your selected renewal plan is charged automatically at the end unless cancelled in Stripe.'} The owner receives a reminder email 24 hours before the trial ends.</p>` : ''}
      ${subscription?.cancel_at_period_end ? `<p>Cancellation scheduled. Access continues until ${esc(date(subscription.trial_ends_at || subscription.current_period_end))}.</p>` : ''}
      ${subscription?.pending_change ? `<p data-household-pending-change>Basic · USD 9.99/month is scheduled for ${esc(date(subscription.pending_change.effective_at))}. Pro stays available until then. Your saved finances are retained.</p>` : ''}
      ${!owner ? '<p class="coach-note">Ask your household owner to choose or manage the subscription. Members cannot change billing.</p>' : `
      ${verificationRequired ? `<div class="coach-note"><h3>Verify your email before checkout</h3><p>Open the verification link sent to your email, then return here. Your selected plan is <strong>${selected === 'basic' ? 'Basic · USD 9.99/month' : 'Pro · USD 14.99/month'}</strong>; you can change it below. No subscription starts until you complete Stripe Checkout.</p><button type="button" class="btn btn-secondary" data-resend-verification>Resend verification email</button><button type="button" class="btn btn-secondary" data-refresh-verification>I verified my email · refresh</button><p class="verification-status" role="status"></p></div>` : ''}
      <form id="household-checkout-form">
        <fieldset class="upgrade-plans"><legend>Choose a household plan</legend>
          <label class="upgrade-option"><input type="radio" name="household-plan" value="basic"${selected === 'basic' ? ' checked' : ''}> <strong>Basic · USD 9.99/month</strong><p>Imports, accounts, transactions, categories and everyday dashboard.</p></label>
          <label class="upgrade-option upgrade-plus"><input type="radio" name="household-plan" value="pro"${selected !== 'basic' ? ' checked' : ''}> <strong>Pro · USD 14.99/month</strong><p>Everything in Basic, plus all analytics, budgets, debt planning and savings goals.</p></label>
        </fieldset>
        <p>${entitlement.trialAvailable ? 'Start a 15-day trial with all Pro features. ' : ''}Stripe hosted Checkout collects your payment details and confirms your selected plan. No payment details are entered in this app.</p>
        <p>${entitlement.trialAvailable ? 'When the trial ends, your selected plan is charged automatically unless cancelled. Cancel through the Stripe billing portal; trial access continues to its end. The owner receives a reminder email 24 hours before the trial ends.' : 'Review your recurring monthly charge in Stripe before subscribing. Manage or cancel an existing subscription through the Stripe billing portal.'}</p>
        <label class="household-consent"><input type="checkbox" id="household-consent" required> I agree to the selected household plan’s recurring charge${entitlement.trialAvailable ? ' after the 15-day trial unless I cancel' : ''}.</label>
        <div class="pro-actions"><button class="btn btn-primary"${!data.configured || managedSubscription || verificationRequired ? ' disabled' : ''}>${entitlement.trialAvailable ? 'Continue to Stripe · 15-day trial' : 'Continue to Stripe'}</button></div>
      </form>
      ${subscription && !subscription.schedule_managed && !subscription.pending_change ? '<button type="button" class="btn btn-secondary" data-household-portal>Manage plan or cancel in Stripe</button>' : ''}
      ${subscription?.pending_change ? '<button type="button" class="btn btn-secondary" data-household-keep-pro>Keep Pro · remove scheduled downgrade</button><p>Remove the scheduled downgrade before opening Stripe to cancel your subscription. Keeping Pro retains your USD 14.99/month renewal.</p>' : subscription?.schedule_managed ? '<p>A Stripe schedule manages this subscription. Contact support before changing or cancelling it.</p>' : ''}
      ${subscription?.plan === 'basic' && subscription.status === 'active' && !subscription.cancel_at_period_end && !subscription.schedule_managed ? '<button type="button" class="btn btn-primary" data-household-upgrade>Upgrade to Pro in Stripe</button><p>Review the prorated upgrade charge in Stripe before confirming. Pro unlocks after payment is confirmed. Your monthly renewal date stays the same.</p>' : ''}
      ${subscription?.plan === 'pro' && ['active', 'trialing'].includes(subscription.status) && !subscription.cancel_at_period_end && !subscription.pending_change ? `<form data-household-downgrade-form><h3>Switch to Basic at next renewal</h3><p>Keep Pro until ${esc(date(subscription.current_period_end || subscription.trial_ends_at))}. Then Basic renews automatically at USD 9.99/month until cancelled. No charge or credit today. Saved data is retained; Pro-only tools become unavailable.</p><label><input type="checkbox" id="household-downgrade-consent" required> I agree to switch to Basic at USD 9.99/month starting ${esc(date(subscription.current_period_end || subscription.trial_ends_at))}, renewing monthly until cancelled.</label><button type="submit" class="btn btn-secondary" data-household-downgrade>Confirm Basic at next renewal</button></form>` : ''}
      ${managedSubscription ? '<p>Use the Stripe billing portal to manage payment details or cancel. A second checkout is not needed.</p>' : ''}
      ${!data.configured ? '<p role="alert">Online billing is not configured. Contact your administrator. Existing paid access is unchanged.</p>' : ''}
      ${entitlement.active && !subscription ? '<p>Your existing paid access is retained. No new subscription is required.</p>' : ''}`}
      <p class="household-error" role="alert"></p>`;
  }
  function bindBilling(root, data) {
    const error = root.querySelector('.household-error');
    root.querySelector('[data-resend-verification]')?.addEventListener('click', async event => {
      event.target.disabled = true;
      try {
        await post('/api/auth/resend-verification');
        root.querySelector('.verification-status').textContent = 'Verification email sent. Check your inbox and spam folder.';
      } catch (failure) { error.textContent = failure.message; }
      finally { event.target.disabled = false; }
    });
    root.querySelector('[data-refresh-verification]')?.addEventListener('click', () => location.reload());
    root.querySelector('#household-checkout-form')?.addEventListener('submit', async event => {
      event.preventDefault();
      if (!data.owner || support() || !data.configured) return;
      if (data.subscription && !['canceled', 'incomplete_expired'].includes(data.subscription.status)) {
        error.textContent = 'Manage your existing subscription through the Stripe billing portal.';
        return;
      }
      if (window.FinanceSession?.currentUser?.()?.emailVerified === false) { error.textContent = 'Verify your email before continuing to Stripe Checkout.'; return; }
      const consent = root.querySelector('#household-consent').checked;
      if (!consent) { error.textContent = 'Please agree to the selected recurring plan before continuing.'; return; }
      const plan = root.querySelector('input[name="household-plan"]:checked')?.value;
      if (!['basic', 'pro'].includes(plan)) { error.textContent = 'Choose Basic or Pro.'; return; }
      const button = event.target.querySelector('button');
      button.disabled = true;
      error.textContent = '';
      try { external((await post('/api/billing/checkout', { plan, consent: true })).url); }
      catch (failure) {
        button.disabled = false;
        if (failure.code === 'EMAIL_VERIFICATION_REQUIRED') {
          const currentUser = window.FinanceSession?.currentUser?.();
          if (currentUser) currentUser.emailVerified = false;
          await renderBilling(root, '', plan);
          root.querySelector('.household-error').textContent = failure.message;
        } else error.textContent = failure.message;
      }
    });
    root.querySelector('[data-household-portal]')?.addEventListener('click', async event => {
      if (!data.owner || support()) return;
      event.target.disabled = true;
      error.textContent = '';
      try { external((await post('/api/billing/portal')).url); }
      catch (failure) { error.textContent = failure.message; event.target.disabled = false; }
    });
    root.querySelector('[data-household-upgrade]')?.addEventListener('click', async event => {
      if (!data.owner || support()) return;
      event.target.disabled = true;
      error.textContent = '';
      try { external((await post('/api/billing/portal', { plan: 'pro' })).url); }
      catch (failure) { error.textContent = failure.message; event.target.disabled = false; }
    });
    const confirmDowngrade = async event => {
      event.preventDefault?.();
      if (!data.owner || support()) return;
      const consent = root.querySelector('#household-downgrade-consent').checked;
      if (!consent) { error.textContent = 'Confirm the Basic recurring charge before continuing.'; return; }
      const button = root.querySelector('[data-household-downgrade]');
      button.disabled = true;
      error.textContent = '';
      try {
        await post('/api/billing/downgrade', { consent, effectiveAt: data.subscription.current_period_end || data.subscription.trial_ends_at });
        await renderBilling(root, 'Basic is scheduled for your next renewal. Pro remains available until then.');
      } catch (failure) { error.textContent = failure.message; button.disabled = false; }
    };
    root.querySelector('[data-household-downgrade-form]')?.addEventListener('submit', confirmDowngrade);
    root.querySelector('[data-household-downgrade]')?.addEventListener('click', confirmDowngrade);
    root.querySelector('[data-household-keep-pro]')?.addEventListener('click', async event => {
      if (!data.owner || support()) return;
      event.target.disabled = true;
      error.textContent = '';
      try {
        await post('/api/billing/downgrade/cancel');
        await renderBilling(root, 'Scheduled downgrade removed. Pro continues at USD 14.99/month.');
      } catch (failure) { error.textContent = failure.message; event.target.disabled = false; }
    });
  }
  async function renderBilling(root, reason, selected) {
    root.innerHTML = '<p role="status">Loading household billing…</p>';
    try {
      const data = await request('/api/billing');
      pro().setEntitlement(data.entitlement);
      root.innerHTML = billingMarkup(data, reason, selected);
      bindBilling(root, data);
    } catch (error) {
      root.innerHTML = `<p role="alert">${esc(error.message)}</p><button type="button" class="btn btn-secondary" data-household-retry>Retry billing</button>`;
      root.querySelector('[data-household-retry]').onclick = () => renderBilling(root, reason, selected);
    }
  }
  async function openBilling(reason = '', selected = 'pro') {
    let dialog = $('household-billing-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'household-billing-dialog';
      dialog.className = 'editor pro-dialog';
      dialog.setAttribute('aria-labelledby', 'household-billing-title');
      document.body.appendChild(dialog);
    }
    dialog.innerHTML = '<div id="household-dialog-content"></div><div class="pro-actions"><button type="button" class="btn btn-secondary" data-household-close>Close</button></div>';
    dialog.querySelector('[data-household-close]').onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
    await renderBilling($('household-dialog-content'), reason, selected);
  }
  async function renderMembers(root) {
    root.innerHTML = '<p role="status">Loading household…</p>';
    try {
      const data = await request('/api/household');
      const owner = data.owner && !support();
      root.innerHTML = `<h2>Household · ${esc(data.name)}</h2><p>Everyone in this household can edit shared finances. Only the owner can invite or remove members. Up to 10 members per household; invitation links expire after 48 hours.</p>
        <ul class="household-members">${data.members.map(member => `<li><span><strong>${esc(member.name)}</strong><br>${esc(member.email)} · ${esc(member.role)}</span>${owner && member.role !== 'owner' ? `<button type="button" class="btn btn-secondary" data-remove-member="${esc(member.id)}">Remove <span class="sr-only">${esc(member.name)}</span></button>` : ''}</li>`).join('')}</ul>
        ${owner ? `<form id="household-invite-form" class="toolbar"><label>Email address<input type="email" name="email" required autocomplete="email" maxlength="254"></label><button class="btn btn-primary">Invite member</button></form>
          <h3>Pending invitations</h3><ul class="household-members">${data.invitations.map(invite => `<li><span>${esc(invite.email)} · expires ${esc(date(invite.expires_at))}</span><button type="button" class="btn btn-secondary" data-revoke-invite="${esc(invite.id)}">Revoke<span class="sr-only"> invitation to ${esc(invite.email)}</span></button></li>`).join('') || '<li>No pending invitations.</li>'}</ul>` : ''}
        <p class="household-error" role="alert"></p><p class="household-status" role="status"></p>`;
      const perform = async (action, button, success) => {
        button.disabled = true;
        root.querySelector('.household-error').textContent = '';
        try { await action(); await renderMembers(root); root.querySelector('.household-status').textContent = success; }
        catch (error) { root.querySelector('.household-error').textContent = error.message; button.disabled = false; }
      };
      root.querySelector('#household-invite-form')?.addEventListener('submit', event => {
        event.preventDefault();
        const form = event.target;
        perform(() => post('/api/household/invitations', { email: form.querySelector('input').value.trim() }), form.querySelector('button'), 'Invitation sent.');
      });
      root.querySelectorAll('[data-remove-member], [data-revoke-invite]').forEach(button => button.addEventListener('click', () => {
          if (!owner || support()) return;
        const member = button.dataset.removeMember;
        if (member && !window.confirm('Remove this member’s access to shared household finances?')) return;
        const path = member ? `members/${encodeURIComponent(member)}` : `invitations/${encodeURIComponent(button.dataset.revokeInvite)}`;
        perform(() => request(`/api/household/${path}`, { method: 'DELETE' }), button, member ? 'Member removed.' : 'Invitation revoked.');
      }));
    } catch (error) { root.innerHTML = `<p role="alert">${esc(error.message)}</p>`; }
  }
  async function loadSettings() {
    const settings = $('settings-view');
    if (!settings) return;
    let billing = $('household-billing');
    let members = $('household-members');
    if (!billing) {
      billing = document.createElement('div');
      billing.id = 'household-billing';
      billing.className = 'panel plan-card household-card';
      settings.appendChild(billing);
      members = document.createElement('div');
      members.id = 'household-members';
      members.className = 'panel plan-card household-card';
      settings.appendChild(members);
    }
    await Promise.all([renderBilling(billing), renderMembers(members)]);
  }
  const baseShowView = window.showView;
  window.showView = async function(route = 'dashboard') {
    if (!window.FinanceSession?.isAuthenticated?.()) return;
    const ticket = ++routeGeneration;
    const name = route.split('/')[0];
    const accessible = ['settings', 'tutorials', 'knowledge-base'];
    if (accessible.includes(name)) {
      baseShowView(route);
      if (name === 'settings') await loadSettings();
      return;
    }
    try {
      const entitlement = await pro().ensureEntitlement();
      if (ticket !== routeGeneration) return;
      const advanced = ['analytics', 'payoff', 'goals', 'insights'].includes(name);
      if (!entitlement.active || (advanced && !entitlement.plusActive)) {
        baseShowView(name === 'subscription' ? route : 'subscription');
        let view = $('subscription-view');
        if (!view) {
          view = document.createElement('section');
          view.id = 'subscription-view';
          view.className = 'view active household-card';
          document.querySelector('.main-content').appendChild(view);
        }
        view.classList.add('active');
        const routePlan = name === 'subscription' && ['basic', 'pro'].includes(route.split('/')[1]) ? route.split('/')[1] : '';
        await renderBilling(view, entitlement.active ? 'Analytics, budgets, debt planning and goals are included in household Pro.' : 'Complete the steps below to start using your household finances.', advanced ? 'pro' : routePlan || window.FinanceSession.chosenPlan?.() || 'pro');
        return;
      }
      baseShowView(name === 'subscription' ? 'dashboard' : route);
    } catch (error) {
      baseShowView('subscription');
      let view = $('subscription-view');
      if (!view) {
        view = document.createElement('section');
        view.id = 'subscription-view';
        document.querySelector('.main-content').appendChild(view);
      }
      view.className = 'view active household-card';
      view.innerHTML = `<h2>Unable to verify household access</h2><p role="alert">${esc(error.message)}</p><button type="button" class="btn btn-primary" data-access-retry>Retry</button>`;
      view.querySelector('[data-access-retry]').onclick = () => window.showView(route);
    }
  };
  window.FinanceHousehold = { openBilling, loadSettings, billingMarkup, external };
})();
