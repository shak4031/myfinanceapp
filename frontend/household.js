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
  function planCard(plan, name, checked, disabled = false) {
    const basic = plan === 'basic';
    return `<label class="household-plan-option${basic ? '' : ' household-plan-pro'}"><input type="radio" name="${name}" value="${plan}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
      <span class="household-plan-heading"><strong>${basic ? 'Basic' : 'Pro'}</strong><span class="household-plan-check" aria-hidden="true">&#10003;</span></span><span class="household-plan-price">${basic ? '$9.99' : '$14.99'} <small>/ month</small></span><span>${basic ? 'Everyday finances, imports and your Financial Health program.' : 'Basic plus analytics and advanced planning.'}</span></label>`;
  }
  function billingMarkup(data, reason = '', selected = 'pro') {
    const entitlement = data.entitlement || {};
    const subscription = data.subscription;
    const managedSubscription = subscription && !['canceled', 'incomplete_expired'].includes(subscription.status);
    const owner = data.owner && !support();
    const retainedAccess = entitlement.active && entitlement.source !== 'self-service-trial' && !managedSubscription;
    const complimentaryAccess = retainedAccess && ['owner', 'demo'].includes(entitlement.source);
    const canChoosePlan = owner && !managedSubscription && !retainedAccess;
    const canUpgrade = subscription?.plan === 'basic' && subscription.status === 'active' && !subscription.cancel_at_period_end && !subscription.schedule_managed;
    const canDowngrade = subscription?.plan === 'pro' && ['active', 'trialing'].includes(subscription.status)
      && !subscription.cancel_at_period_end && !subscription.pending_change && !subscription.schedule_managed;
    const displayedPlan = managedSubscription ? subscription.plan : entitlement.tier;
    const showPlanChoices = (managedSubscription || (retainedAccess && !complimentaryAccess)) && ['basic', 'pro'].includes(displayedPlan);
    const alternateAvailable = retainedAccess || canUpgrade || canDowngrade;
    const verificationRequired = window.FinanceSession?.currentUser?.()?.emailVerified === false;
    return `<h2>Your household plan</h2>
      ${reason ? `<p>${esc(reason)}</p>` : ''}
      <p>One plan covers your household.</p>
      ${entitlement.active || subscription ? `<p><strong>${esc(pro().planLabel(entitlement).title)}</strong>${subscription ? ` · ${esc(subscription.status)}` : ''}</p>` : ''}
      ${subscription ? `<p>${!managedSubscription ? 'Previous plan' : subscription.cancel_at_period_end ? 'Current plan' : 'Selected renewal plan'}: <strong>${(subscription.pending_change?.plan === 'basic' && !subscription.cancel_at_period_end) || subscription.plan === 'basic' ? 'Basic · USD 9.99/month' : subscription.plan === 'pro' ? 'Pro · USD 14.99/month' : esc(subscription.plan || 'Not available')}</strong>. ${!managedSubscription ? 'Period ended' : subscription.cancel_at_period_end ? 'Cancellation scheduled. Subscription ends' : 'Current period ends'}: ${esc(date(subscription.current_period_end || subscription.trial_ends_at))}.</p>` : ''}
      ${entitlement.tier === 'trial' ? `<p>Pro trial ends ${esc(date(entitlement.trialEndsAt || subscription?.trial_ends_at))}. ${entitlement.source === 'self-service-trial' ? 'No payment details are required; access ends automatically unless you subscribe.' : subscription?.cancel_at_period_end ? 'Your trial will not renew.' : 'Your selected plan renews automatically; the owner receives a reminder 24 hours before the trial ends.'}</p>` : ''}
      ${subscription?.pending_change ? `<p data-household-pending-change>Basic · USD 9.99/month is scheduled for ${esc(date(subscription.pending_change.effective_at))}. Pro stays available until then. Your saved finances are retained.</p>` : ''}
      ${!owner ? '<p class="coach-note">Ask your household owner to choose or manage the subscription. Members cannot change billing.</p>' : `
      ${canChoosePlan && verificationRequired ? `<div class="coach-note"><h3>Verify your email before checkout</h3><p>Open your verification email, then return here.</p><button type="button" class="btn btn-secondary" data-resend-verification>Resend verification email</button><button type="button" class="btn btn-secondary" data-refresh-verification>I verified my email · refresh</button><p class="verification-status" role="status"></p></div>` : ''}
      ${canChoosePlan ? `<form id="household-checkout-form">
        <fieldset class="household-plan-options"><legend>Choose a household plan</legend>
          ${planCard('basic', 'household-plan', selected === 'basic')}
          ${planCard('pro', 'household-plan', selected !== 'basic')}
        </fieldset>
        <p>Stripe charges immediately and renews monthly until cancelled. Subscribing ends any remaining trial.</p>
        <label class="household-consent"><input type="checkbox" id="household-consent" required> I agree to the immediate and recurring monthly charge.</label>
        <div class="pro-actions"><button class="btn btn-primary"${!data.configured || verificationRequired ? ' disabled' : ''}>Continue to Stripe</button></div>
      </form>` : ''}
      ${showPlanChoices ? `<fieldset class="household-plan-options"><legend>Choose your plan</legend>
        ${planCard('basic', 'membership-plan', displayedPlan === 'basic', displayedPlan !== 'basic' && !alternateAvailable)}
        ${planCard('pro', 'membership-plan', displayedPlan === 'pro', displayedPlan !== 'pro' && !alternateAvailable)}
      </fieldset>
      ${canDowngrade ? `<form data-household-downgrade-form hidden>
        <p>Pro continues until ${esc(date(subscription.current_period_end || subscription.trial_ends_at))}. No charge or credit today; saved data stays, but Pro tools become unavailable.</p>
        <label class="household-consent"><input type="checkbox" id="household-downgrade-consent" required> I agree to Basic at USD 9.99/month from that date, renewing monthly until cancelled.</label>
        <button type="submit" class="btn btn-primary" data-household-downgrade>Confirm switch to Basic</button></form>` : ''}
      ${canUpgrade ? '<div data-household-upgrade-options hidden><p>Review the prorated charge in Stripe; your renewal date stays the same.</p><button type="button" class="btn btn-primary" data-household-upgrade>Upgrade to Pro in Stripe</button></div>' : ''}
      ${retainedAccess ? '<div data-household-license-options hidden><p>To change this access, contact support.</p><a href="#settings">Contact support &rarr;</a></div>' : ''}` : ''}
      ${managedSubscription && !canUpgrade && !canDowngrade && !subscription.pending_change && !subscription.schedule_managed ? `<p>${subscription.cancel_at_period_end ? 'Manage billing in Stripe to change your scheduled cancellation.' : subscription.status === 'trialing' ? 'Plan changes are available after your Stripe trial ends.' : !['active'].includes(subscription.status) ? 'Manage billing in Stripe before changing plans.' : ''}</p>` : ''}
      ${subscription && !subscription.schedule_managed && !subscription.pending_change ? '<button type="button" class="btn btn-secondary" data-household-portal>Manage billing in Stripe</button>' : ''}
      ${subscription && ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status) && !subscription.cancel_at_period_end && !subscription.schedule_managed && !subscription.pending_change ? '<button type="button" class="household-cancel-link" data-household-cancel>Cancel membership</button>' : ''}
      ${subscription?.pending_change ? '<button type="button" class="btn btn-secondary" data-household-keep-pro>Keep Pro · remove scheduled downgrade</button><p>Remove the scheduled downgrade before opening Stripe to cancel your subscription. Keeping Pro retains your USD 14.99/month renewal.</p>' : subscription?.schedule_managed ? '<p>A Stripe schedule manages this subscription. Contact support before changing or cancelling it.</p>' : ''}
      ${canChoosePlan && !data.configured ? '<p role="alert">Online billing is not configured. Contact your administrator.</p>' : ''}
      ${complimentaryAccess ? '<p>This account includes complimentary Pro access and has no Stripe subscription to manage.</p>' : retainedAccess ? '<p>Your access is not a Stripe subscription. <a href="#settings">Contact support</a> to change it.</p>' : ''}`}
      <p class="household-error" role="alert"></p>`;
  }
  function bindBilling(root, data) {
    const error = root.querySelector('.household-error');
    const currentPlan = data.subscription && !['canceled', 'incomplete_expired'].includes(data.subscription.status)
      ? data.subscription.plan : data.entitlement?.tier;
    const updatePlanChoice = event => {
      const selected = event.target.value;
      const downgrade = root.querySelector('[data-household-downgrade-form]');
      const upgrade = root.querySelector('[data-household-upgrade-options]');
      const license = root.querySelector('[data-household-license-options]');
      if (downgrade) downgrade.hidden = selected !== 'basic' || selected === currentPlan;
      if (upgrade) upgrade.hidden = selected !== 'pro' || selected === currentPlan;
      if (license) license.hidden = selected === currentPlan;
      const consent = root.querySelector('#household-downgrade-consent');
      if (consent && downgrade?.hidden) consent.checked = false;
      error.textContent = '';
    };
    root.querySelector('input[name="membership-plan"][value="basic"]')?.addEventListener('change', updatePlanChoice);
    root.querySelector('input[name="membership-plan"][value="pro"]')?.addEventListener('change', updatePlanChoice);
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
    root.querySelector('[data-household-cancel]')?.addEventListener('click', async event => {
      if (!data.owner || support() || !data.subscription || !['active', 'trialing', 'past_due', 'unpaid'].includes(data.subscription.status)
        || data.subscription.cancel_at_period_end || data.subscription.schedule_managed || data.subscription.pending_change) return;
      event.target.disabled = true;
      error.textContent = '';
      try {
        const confirmed = await window.FinanceUI.confirm('Cancellation takes effect at the end of your billing period or Stripe trial. Continue to Stripe to confirm cancellation?', { title: 'Cancel membership?', action: 'Continue to Stripe' });
        if (!confirmed) { event.target.disabled = false; return; }
        external((await post('/api/billing/portal', { action: 'cancel' })).url);
      } catch (failure) { error.textContent = failure.message; event.target.disabled = false; }
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
    const shortcut = root.id === 'household-billing' ? $('membership-choose-plan') : null;
    if (shortcut) shortcut.hidden = true;
    try {
      const data = await request('/api/billing');
      pro().setEntitlement(data.entitlement);
      root.innerHTML = billingMarkup(data, reason, selected);
      bindBilling(root, data);
      if (shortcut && data.owner && !support() && (!data.subscription || ['canceled', 'incomplete_expired'].includes(data.subscription.status))
        && (!data.entitlement.active || data.entitlement.source === 'self-service-trial')) {
        shortcut.hidden = false;
        shortcut.onclick = () => {
          const form = root.querySelector('#household-checkout-form');
          form?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
          form?.querySelector('input[name="household-plan"]:checked')?.focus({ preventScroll: true });
        };
      }
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
      dialog.setAttribute('aria-label', 'Household billing');
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
      root.innerHTML = `<h2>Household · ${esc(data.name)}</h2><p>Members can edit shared finances. Up to 10 members; invitations expire after 48 hours.</p>
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
    const membership = $('membership-view');
    if (!membership) return;
    const profile = $('membership-profile');
    const user = window.FinanceSession?.currentUser?.();
    if (profile) profile.textContent = [user?.name, user?.email].filter(Boolean).join(' · ');
    let billing = $('household-billing');
    let members = $('household-members');
    if (!billing) {
      billing = document.createElement('div');
      billing.id = 'household-billing';
      billing.className = 'panel plan-card household-card membership-card';
      membership.appendChild(billing);
      members = document.createElement('div');
      members.id = 'household-members';
      members.className = 'panel plan-card household-card membership-card';
      membership.appendChild(members);
    }
    await Promise.all([renderBilling(billing), renderMembers(members)]);
  }
  const baseShowView = window.showView;
  window.showView = async function(route = 'dashboard') {
    if (!window.FinanceSession?.isAuthenticated?.()) return;
    if (route === 'settings/billing') route = 'membership';
    const ticket = ++routeGeneration;
    const name = route.split('/')[0];
    const accessible = ['membership', 'settings', 'tutorials', 'knowledge-base'];
    if (accessible.includes(name)) {
      baseShowView(route);
      if (name === 'membership') await loadSettings();
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
