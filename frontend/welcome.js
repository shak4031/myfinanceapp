// Dashboard welcome: greeting, rotating insights and a "today" pulse.
(function () {
  const ROTATE_MS = 7000;
  const TOUR_SEEN_KEY = 'mf.tutorials.dashboardSeen';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const money = (value, digits = 0) => `${value < 0 ? '−' : ''}$${Math.abs(Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  const ordinal = day => `${day}${day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th')}`;
  const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const storage = {
    get: key => { try { return window.localStorage?.getItem(key); } catch { return null; } },
    set: (key, value) => { try { window.localStorage?.setItem(key, value); } catch { /* private mode */ } }
  };

  const ICONS = {
    alert: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17v.5"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-1V4.5a1.5 1.5 0 0 1 3 0V11m0-4.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 15a1.6 1.6 0 0 1 2.6-1.8L8 15.5"/>',
    cash: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v.01M18 14.5v.01"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
    gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 4-6"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    repeat: '<path d="M4 12a7 7 0 0 1 12-5l2 2M20 12a7 7 0 0 1-12 5l-2-2"/><path d="M18 4v5h-5M6 20v-5h5"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 15v5h16v-5"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5Z" fill="currentColor"/>',
    pause: '<path d="M9 6v12M15 6v12"/>', resume: '<path d="m8 5 11 7-11 7Z"/>',
    left: '<path d="m14.5 6-6 6 6 6"/>', right: '<path d="m9.5 6 6 6-6 6"/>', arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>'
  };
  const icon = (name, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.spark}</svg>`;
  const TONE_LABEL = { danger: 'Needs attention', warning: 'Heads up', info: 'Good to know', success: 'Nice work', pro: 'MyFinance Pro', learn: 'Getting started' };

  const state = { data: null, index: 0, timer: null, started: 0, remaining: ROTATE_MS, paused: false, hover: false, userPaused: false, request: 0 };

  function firstName() {
    const text = ($('account-name')?.textContent || '').trim();
    if (!text || text.includes('@')) return '';
    return text.split(/\s+/)[0];
  }
  function greeting(now = new Date()) {
    const hour = now.getHours();
    return hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  }

  function withTour(insights) {
    const list = [...insights];
    if (!storage.get(TOUR_SEEN_KEY)) {
      list.push({ id: 'tour', tone: 'learn', icon: 'play', title: 'New here? Take a one-minute tour',
        detail: 'Short, narrated walkthroughs show how the dashboard, the debt-free plan and goals work together.',
        action: { label: 'Watch the tutorials', view: 'tutorials' } });
    }
    return list;
  }

  function headline(insights) {
    const urgent = insights.filter(item => item.tone === 'danger').length;
    const heads = insights.filter(item => item.tone === 'warning').length;
    if (urgent) return `${urgent === 1 ? 'One thing needs' : `${urgent} things need`} your attention today.`;
    if (heads) return `Mostly calm, with ${heads === 1 ? 'one heads-up' : `${heads} heads-ups`} worth a look.`;
    return 'Everything looks on track. Here is what is coming up.';
  }

  const MASCOT = { alert: '⚠️', calendar: '📅', hand: '✋', cash: '💸', flag: '🏁', target: '🎯', gauge: '🔥', trend: '📈', search: '🔍', repeat: '🔁', spark: '✨', shield: '🛡️', upload: '📤', play: '🎬' };
  const MOOD = { danger: ['🚨', 'Action needed'], warning: ['👀', 'Heads up'], calm: ['🌤️', 'All clear'] };
  // Each slide enters with its own motion so the rotation never feels repetitive.
  const EFFECTS = ['rise', 'pop', 'swipe', 'flip', 'cascade', 'zoom'];
  const HIGHLIGHT = /([−-]?\$[\d,]+(?:\.\d+)?[kKmM]?|\d+(?:\.\d+)?%|\b\d{1,2}(?:st|nd|rd|th)\b|\b\d+ (?:days?|weeks?|months?)\b|\b(?:today|tomorrow)\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b)/i;

  function mood(insights) {
    if (insights.some(item => item.tone === 'danger')) return ['danger', ...MOOD.danger];
    if (insights.some(item => item.tone === 'warning')) return ['warning', ...MOOD.warning];
    return ['calm', ...MOOD.calm];
  }

  // Splits a title into word spans (for staggered entrances) and marks money, percentages and dates.
  function titleArt(title) {
    let word = 0;
    return String(title ?? '').split(HIGHLIGHT).map((part, i) => {
      if (!part) return '';
      if (i % 2) return `<span class="welcome-w" style="--i:${word++}"><mark class="welcome-hl">${esc(part)}</mark></span>`;
      return part.split(/(\s+)/).map(bit => /^\s+$/.test(bit) ? ' ' : bit ? `<span class="welcome-w" style="--i:${word++}">${esc(bit)}</span>` : '').join('');
    }).join('');
  }

  function pulseRows(pulse) {
    const today = new Date().getDate();
    const rows = [];
    rows.push(['🏦', 'Balance', pulse.balance == null ? '—' : money(pulse.balance, 2), pulse.balance == null ? 'Import a statement with balances' : 'Latest recorded', pulse.balance != null && pulse.balance < 0 ? 'bad' : 'mint']);
    if (pulse.nextIncome) {
      const away = pulse.nextIncome.daysAway;
      rows.push(['💰', 'Next payday', money(pulse.nextIncome.amount), away === 0 ? 'Today' : away === 1 ? 'Tomorrow' : `In ${away} days · the ${ordinal(pulse.nextIncome.day)}`, 'good']);
    }
    const safe = pulse.safeToSpend;
    if (safe) {
      const until = safe.untilDay ? `before payday on the ${ordinal(safe.untilDay)}` : 'before month end';
      const how = globalThis.FinanceUI?.howCalc?.(`Your latest balance (${money(pulse.balance, 2)}) minus ${safe.count} bill${safe.count === 1 ? '' : 's'} and planned payment${safe.count === 1 ? '' : 's'} totaling ${money(safe.committed, 2)} due ${until}. Paychecks are not counted until they arrive.`, 'How safe to spend is calculated') || '';
      rows.push(['🛟', 'Safe to spend', money(safe.amount), safe.untilDay ? `Until payday · the ${ordinal(safe.untilDay)}` : 'Until month end', safe.amount <= 0 ? 'bad' : safe.amount < 250 ? 'warn' : 'good', how]);
    }
    rows.push(['🧾', 'Bills left this month', pulse.billsLeft.count ? money(pulse.billsLeft.total) : 'All paid', pulse.billsLeft.count ? `${pulse.billsLeft.count} payment${pulse.billsLeft.count === 1 ? '' : 's'} to go` : 'Nothing else due', 'sky']);
    if (pulse.lowPoint) rows.push(['📉', 'Lowest point ahead', money(pulse.lowPoint.amount), pulse.lowPoint.day === today ? 'Today' : `On the ${ordinal(pulse.lowPoint.day)}`, pulse.lowPoint.amount < 0 ? 'bad' : pulse.lowPoint.amount < 250 ? 'warn' : 'sky']);
    if (pulse.debtFreeDate) {
      const [year, month] = pulse.debtFreeDate.split('-').map(Number);
      rows.push(['🏁', 'Debt-free', new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), 'On your current plan', 'grape']);
    }
    if (pulse.lastImport && pulse.lastImport.daysAgo >= 7) {
      rows.push(['📥', 'Last import', `${pulse.lastImport.daysAgo} days ago`, pulse.lastImport.latestDate ? `Newest transaction ${new Date(`${pulse.lastImport.latestDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'Import to stay current', pulse.lastImport.daysAgo >= 14 ? 'warn' : 'sky']);
    }
    return rows.map(([emoji, label, value, note, tone, how = ''], i) => `<div class="welcome-pulse-row is-${tone}" style="--i:${i}"><dt><span class="welcome-pulse-emoji" aria-hidden="true">${emoji}</span>${esc(label)}${how}</dt><dd><strong>${esc(value)}</strong><span>${esc(note)}</span></dd></div>`).join('');
  }

  function actionLink(item, index) {
    if (!item.action) return '';
    const content = `${esc(item.action.label)}${icon('arrow', 16)}`;
    return item.action.view
      ? `<a class="welcome-action" href="#${esc(item.action.view)}" data-view="${esc(item.action.view)}"${item.id === 'tour' ? ' data-welcome-tour' : ''}>${content}</a>`
      : `<button type="button" class="welcome-action" data-welcome-action="${index}">${content}</button>`;
  }
  function slide(item, index, total) {
    const action = actionLink(item, index);
    const burst = item.tone === 'success' || item.tone === 'pro' || item.tone === 'learn'
      ? `<span class="welcome-burst" aria-hidden="true">${'<i></i>'.repeat(8)}</span>` : '';
    return `<article class="welcome-slide tone-${esc(item.tone)} fx-${EFFECTS[index % EFFECTS.length]}${index === state.index ? ' is-active' : ''}" role="group" aria-roledescription="slide" aria-label="${index + 1} of ${total}" aria-hidden="${index !== state.index}" data-index="${index}">
      <span class="welcome-mascot" aria-hidden="true"><span class="welcome-mascot-face">${MASCOT[item.icon] || '✨'}</span>${burst}</span>
      <div class="welcome-slide-copy">
        <span class="welcome-slide-tone">${esc(TONE_LABEL[item.tone] || 'Insight')}</span>
        <h3><span class="visually-hidden">${esc(item.title)}</span><span class="welcome-title-art" aria-hidden="true">${titleArt(item.title)}</span></h3>
        <p>${esc(item.detail)}</p>
        ${action}
      </div>
    </article>`;
  }

  function render() {
    const root = $('welcome-hero');
    if (!root || !state.data) return;
    const insights = state.data.insightsView;
    const name = firstName();
    const today = new Date();
    const [moodTone, moodEmoji, moodLabel] = mood(insights);
    const attention = insights.map((item, index) => ({ item, index })).filter(({ item }) => item.tone === 'danger' || item.tone === 'warning');
    state.index = Math.min(state.index, insights.length - 1);
    root.setAttribute('data-tone', insights[state.index]?.tone || 'info');
    root.innerHTML = `
      <span class="welcome-blob welcome-blob-a" aria-hidden="true"></span><span class="welcome-blob welcome-blob-b" aria-hidden="true"></span><span class="welcome-blob welcome-blob-c" aria-hidden="true"></span>
      <div class="welcome-top">
        <div class="welcome-greeting">
          <p class="welcome-date"><span aria-hidden="true">☀️</span>${esc(today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
          <h1>${esc(greeting(today))}${name ? `, <span class="welcome-name">${esc(name)}</span>` : ''}<span class="welcome-wave" aria-hidden="true">👋</span></h1>
          <p class="welcome-sub">${attention.length ? `<a class="welcome-mood mood-${moodTone}" href="#welcome-attention" data-welcome-attention><span aria-hidden="true">${moodEmoji}</span>${esc(moodLabel)} ${icon('arrow', 14)}</a>` : `<span class="welcome-mood mood-${moodTone}"><span aria-hidden="true">${moodEmoji}</span>${esc(moodLabel)}</span>`}${esc(headline(insights))}</p>
        </div>
        <div class="welcome-top-actions">
          <a class="welcome-ghost" href="#tutorials/dashboard">${icon('play', 15)}Tour</a>
          <button type="button" class="welcome-ghost" onclick="openImportModal()">${icon('upload', 15)}Import</button>
        </div>
      </div>
      ${attention.length ? `<section id="welcome-attention" class="welcome-attention" aria-label="Items needing your attention" tabindex="-1"><ul>${attention.map(({ item, index }) => `<li><div><strong>${esc(item.title)}</strong><p>${esc(item.detail)}</p></div>${actionLink(item, index)}</li>`).join('')}</ul></section>` : ''}
      <section class="welcome-carousel" aria-roledescription="carousel" aria-label="Your insights">
        <div class="welcome-slides" id="welcome-slides" aria-live="off">${insights.map((item, index) => slide(item, index, insights.length)).join('')}</div>
        <div class="welcome-controls">
          <div class="welcome-dots" role="tablist" aria-label="Choose an insight">${insights.map((item, index) => `<button type="button" role="tab" class="welcome-dot tone-${esc(item.tone)}${index === state.index ? ' is-active' : ''}" data-welcome-go="${index}" aria-selected="${index === state.index}" aria-label="${esc(item.title)}"><span></span></button>`).join('')}</div>
          <span class="welcome-count" id="welcome-count">${state.index + 1} / ${insights.length}</span>
          <button type="button" class="welcome-nav" data-welcome-step="-1" aria-label="Previous insight">${icon('left', 18)}</button>
          <button type="button" class="welcome-nav welcome-pause" data-welcome-pause aria-label="${state.userPaused ? 'Resume rotating insights' : 'Pause rotating insights'}" aria-pressed="${state.userPaused}">${icon(state.userPaused ? 'resume' : 'pause', 16)}</button>
          <button type="button" class="welcome-nav" data-welcome-step="1" aria-label="Next insight">${icon('right', 18)}</button>
        </div>
      </section>
      <aside class="welcome-pulse" aria-label="Today at a glance">
        <dl>${pulseRows(state.data.pulse)}</dl>
      </aside>`;
    restart();
  }

  // The stage glides between slide heights instead of reserving space for the tallest one.
  function glideHeight(slides, change) {
    if (!slides || reducedMotion() || typeof slides.offsetHeight !== 'number') return change();
    const from = slides.offsetHeight;
    change();
    const to = slides.offsetHeight;
    if (!from || from === to) return;
    slides.style.height = `${from}px`;
    void slides.offsetHeight;
    slides.style.height = `${to}px`;
    clearTimeout(slides._glide);
    slides._glide = setTimeout(() => { slides.style.height = ''; }, 520);
  }

  function show(index, { announce = false } = {}) {
    const insights = state.data?.insightsView || [];
    if (!insights.length) return;
    const previous = state.index;
    state.index = (index + insights.length) % insights.length;
    const slides = $('welcome-slides');
    const forward = state.index > previous || (previous === insights.length - 1 && state.index === 0);
    glideHeight(slides, () => {
      document.querySelectorAll('#welcome-hero .welcome-slide').forEach(node => {
        const i = Number(node.dataset.index);
        const active = i === state.index;
        const leaving = i === previous && !active && !reducedMotion();
        node.classList.toggle('is-active', active);
        node.classList.toggle('is-back', !forward);
        if (leaving) {
          node.classList.add('is-leaving');
          clearTimeout(node._leave);
          node._leave = setTimeout(() => node.classList.remove('is-leaving'), 480);
        } else if (active) node.classList.remove('is-leaving');
        node.setAttribute('aria-hidden', String(!active));
      });
    });
    $('welcome-hero')?.setAttribute('data-tone', insights[state.index]?.tone || 'info');
    document.querySelectorAll('#welcome-hero .welcome-dot').forEach(node => {
      const active = Number(node.dataset.welcomeGo) === state.index;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-selected', String(active));
    });
    const count = $('welcome-count');
    if (count) count.textContent = `${state.index + 1} / ${insights.length}`;
    if (slides) slides.setAttribute('aria-live', announce ? 'polite' : 'off');
    restart();
  }
  // The active dot fills over ROTATE_MS; pausing freezes both the timer and the fill.
  function restart() {
    clearTimeout(state.timer);
    state.remaining = ROTATE_MS;
    const root = $('welcome-hero');
    root?.style.setProperty('--welcome-rotate', `${ROTATE_MS}ms`);
    root?.querySelectorAll('.welcome-dot span').forEach(node => { node.style.animation = 'none'; void node.offsetWidth; node.style.animation = ''; });
    schedule();
  }
  function schedule() {
    clearTimeout(state.timer);
    const root = $('welcome-hero');
    const paused = state.userPaused || state.hover || reducedMotion() || (state.data?.insightsView.length || 0) < 2 || document.hidden;
    root?.classList.toggle('is-paused', paused);
    if (paused) return;
    state.started = Date.now();
    state.timer = setTimeout(() => show(state.index + 1), state.remaining);
  }
  function hold() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
      state.remaining = Math.max(400, state.remaining - (Date.now() - state.started));
    }
    $('welcome-hero')?.classList.add('is-paused');
  }

  function runAction(item) {
    const action = item?.action;
    if (!action) return;
    if (item.id === 'tour') storage.set(TOUR_SEEN_KEY, '1');
    if (action.view) return window.showView?.(action.view);
    if (action.act === 'upcoming') return $('upcoming-section')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    if (action.act === 'import') return window.openImportModal?.();
    if (action.act === 'pro') return window.FinancePro?.requirePro?.('See budgets, forecasts and spending alerts on your dashboard with MyFinance Pro.');
  }

  function skeleton() {
    const root = $('welcome-hero');
    if (!root || state.data) return;
    root.innerHTML = `<div class="welcome-top"><div class="welcome-greeting"><p class="welcome-date">${esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</p><h1>${esc(greeting())}${firstName() ? `, ${esc(firstName())}` : ''}</h1><p class="welcome-sub">Gathering your insights…</p></div></div>
      <div class="welcome-carousel welcome-skeleton"><span></span><span></span><span></span></div>`;
  }

  async function load() {
    const root = $('welcome-hero');
    if (!root) return;
    const request = ++state.request;
    skeleton();
    try {
      const response = await fetch('/api/dashboard/insights');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Insights are unavailable right now.');
      if (request !== state.request) return;
      const previous = state.data?.insightsView?.[state.index]?.id;
      state.data = { ...data, insightsView: withTour(data.insights || []) };
      const keep = state.data.insightsView.findIndex(item => item.id === previous);
      state.index = keep >= 0 ? keep : 0;
      render();
    } catch (error) {
      if (request !== state.request) return;
      state.data = null;
      root.innerHTML = `<div class="welcome-top"><div class="welcome-greeting"><h1>${esc(greeting())}${firstName() ? `, ${esc(firstName())}` : ''}</h1><p class="welcome-sub">${esc(error.message)}</p></div><div class="welcome-top-actions"><button type="button" class="welcome-ghost" data-welcome-retry>Try again</button></div></div>`;
    }
  }

  document.addEventListener('click', event => {
    const root = $('welcome-hero');
    if (!root || !root.contains(event.target)) return;
    if (event.target.closest('[data-welcome-tour]')) storage.set(TOUR_SEEN_KEY, '1');
    const target = event.target.closest('[data-welcome-action],[data-welcome-go],[data-welcome-step],[data-welcome-pause],[data-welcome-retry],[data-welcome-attention]');
    if (!target) return;
    if (target.hasAttribute('data-welcome-attention')) {
      event.preventDefault();
      $('welcome-attention')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
      $('welcome-attention')?.focus({ preventScroll: true });
      return;
    }
    if (target.hasAttribute('data-welcome-retry')) return load();
    if (target.dataset.welcomeAction != null) return runAction(state.data?.insightsView[Number(target.dataset.welcomeAction)]);
    if (target.dataset.welcomeGo != null) return show(Number(target.dataset.welcomeGo), { announce: true });
    if (target.dataset.welcomeStep != null) return show(state.index + Number(target.dataset.welcomeStep), { announce: true });
    if (target.hasAttribute('data-welcome-pause')) {
      state.userPaused = !state.userPaused;
      target.setAttribute('aria-pressed', String(state.userPaused));
      target.setAttribute('aria-label', state.userPaused ? 'Resume rotating insights' : 'Pause rotating insights');
      target.innerHTML = icon(state.userPaused ? 'resume' : 'pause', 16);
      if (state.userPaused) hold(); else schedule();
    }
  });
  const carouselEvent = (type, handler) => document.addEventListener(type, event => {
    if (event.target.closest?.('#welcome-hero .welcome-carousel')) handler(event);
  }, true);
  carouselEvent('mouseover', () => { if (!state.hover) { state.hover = true; hold(); } });
  carouselEvent('mouseout', event => {
    if (event.relatedTarget?.closest?.('#welcome-hero .welcome-carousel')) return;
    state.hover = false; schedule();
  });
  carouselEvent('focusin', () => { state.hover = true; hold(); });
  carouselEvent('focusout', event => { if (!event.relatedTarget?.closest?.('#welcome-hero .welcome-carousel')) { state.hover = false; schedule(); } });
  carouselEvent('keydown', event => {
    if (event.key === 'ArrowRight') { event.preventDefault(); show(state.index + 1, { announce: true }); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); show(state.index - 1, { announce: true }); }
  });
  let touchX = null;
  carouselEvent('touchstart', event => { touchX = event.touches[0]?.clientX ?? null; });
  carouselEvent('touchend', event => {
    if (touchX == null) return;
    const dx = (event.changedTouches[0]?.clientX ?? touchX) - touchX;
    touchX = null;
    if (Math.abs(dx) > 40) show(state.index + (dx < 0 ? 1 : -1), { announce: true });
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) hold(); else schedule(); });
  let lastPro = null;
  document.addEventListener('pro:entitlement', event => {
    const pro = !!event.detail?.active;
    const changed = lastPro !== null && lastPro !== pro;
    lastPro = pro;
    if (changed && $('dashboard-view')?.classList.contains('active')) load();
  });

  window.FinanceWelcome = { load, render, show, buildHeadline: headline, markTourSeen: () => storage.set(TOUR_SEEN_KEY, '1'), state };
})();
