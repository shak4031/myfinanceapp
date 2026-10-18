// Signed-out marketing page: sticky section navigation and the rotating feature spotlight.
(function () {
  const SLIDES = [
    { tier: 'FREE', emoji: '📥', effect: 'rise', title: 'Drop in a statement.', mark: 'Get the story.', body: 'Import CSV or OFX/QFX files from any bank or credit card, or PDF statements from TD Bank. No bank login, no spreadsheet marathon.', chips: ['CSV or OFX from any bank', 'No bank link', '2-minute start'] },
    { tier: 'FREE', emoji: '🏷️', effect: 'pop', title: 'Every dollar finds', mark: 'its label.', body: 'Fix one coffee shop and MyFinance offers to fix the rest. Your rules sort future imports for you.', chips: ['Smart categories', 'One-tap fix-alls'] },
    { tier: 'FREE', emoji: '📅', effect: 'swipe', title: 'See bills before', mark: 'they see you.', body: 'Mark fixed bills and paydays once. Your calendar shows the running balance, day by day.', chips: ['Fixed bills', 'Payday forecast', 'Low-balance heads-up'] },
    { tier: 'PRO', emoji: '🔎', effect: 'flip', title: 'Catch the sneaky', mark: 'repeat charges.', body: 'Recurring-charge and unusual-charge alerts flag what quietly drains your account.', chips: ['Recurring charges', 'Unusual charges'] },
    { tier: 'PRO', emoji: '📈', effect: 'cascade', title: 'Budgets that nudge,', mark: 'not nag.', body: 'Category budgets, trends and cash-flow forecasts help you adjust before the month gets away.', chips: ['Budgets', 'Forecasts', 'Exports'] },
    { tier: 'PRO PLUS', emoji: '🏁', effect: 'zoom', title: 'Circle your', mark: 'debt-free date.', body: 'Compare Avalanche and Snowball, then watch the finish line move closer with every extra dollar.', chips: ['Payoff strategies', 'What-ifs'] },
    { tier: 'PRO PLUS', emoji: '🎯', effect: 'rise', title: 'Give every dream', mark: 'a deadline.', body: 'Emergency fund, first home, a big trip. Monthly targets turn "someday" into a date.', chips: ['Savings goals', 'Monthly targets'] }
  ];
  const INTERVAL = 6500;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const signedOut = () => document.body.classList.contains('auth-pending');
  const state = { index: 0, hover: false, focus: false, paused: false, started: false };

  function slideHtml(slide, index) {
    const words = slide.title.split(' ').map((word, i) => `<span class="mk-word" style="--i:${i}">${esc(word)}</span>`).join(' ');
    return `<div class="mk-slide mk-fx-${slide.effect}" role="group" aria-roledescription="slide" aria-label="${index + 1} of ${SLIDES.length}: ${esc(`${slide.title} ${slide.mark}`)}">
      <span class="mk-tier mk-tier-${slide.tier.toLowerCase().replace(/\s+/g, '-')}">${esc(slide.tier)}</span>
      <span class="mk-emoji" aria-hidden="true">${slide.emoji}</span>
      <h3>${words} <mark>${esc(slide.mark)}</mark></h3>
      <p>${esc(slide.body)}</p>
      <div class="mk-chips">${slide.chips.map((chip, i) => `<span style="--i:${i}">${esc(chip)}</span>`).join('')}</div>
    </div>`;
  }

  function moving() { return !state.paused && !state.hover && !state.focus && !reducedMotion() && !document.hidden && signedOut(); }

  function render(direction = 1) {
    const stage = $('marketing-spotlight-stage');
    if (!stage) return;
    stage.innerHTML = slideHtml(SLIDES[state.index], state.index);
    stage.dataset.direction = direction < 0 ? 'back' : 'forward';
    stage.setAttribute('aria-live', moving() ? 'off' : 'polite');
    document.querySelectorAll('#marketing-spotlight-dots button').forEach((dot, i) => {
      const current = i === state.index;
      dot.classList.toggle('is-current', current);
      if (current) dot.setAttribute('aria-current', 'true'); else dot.removeAttribute('aria-current');
    });
    schedule();
  }

  function schedule() {
    const spotlight = $('marketing-spotlight');
    if (!spotlight) return;
    spotlight.classList.toggle('is-running', moving());
    spotlight.style.setProperty('--mk-interval', `${INTERVAL}ms`);
    const toggle = $('marketing-spotlight-toggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(state.paused));
      toggle.setAttribute('aria-label', state.paused ? 'Play feature tour' : 'Pause feature tour');
      toggle.innerHTML = state.paused ? '<span aria-hidden="true">&#9654;</span>' : '<span aria-hidden="true">&#10074;&#10074;</span>';
    }
  }

  // The current dot's progress fill is the timer, so pausing freezes the bar and the rotation together.
  function advance() {
    if (!moving()) return;
    state.index = (state.index + 1) % SLIDES.length;
    render(1);
  }

  function buildSpotlight() {
    const spotlight = $('marketing-spotlight');
    if (!spotlight || state.started) return;
    state.started = true;
    $('marketing-spotlight-dots').innerHTML = SLIDES.map((slide, i) => `<button type="button" data-mk-go="${i}" aria-label="Show feature ${i + 1} of ${SLIDES.length}: ${esc(`${slide.title} ${slide.mark}`)}"><i></i></button>`).join('');
    spotlight.addEventListener('click', event => {
      const target = event.target.closest?.('[data-mk-go], [data-mk-step], #marketing-spotlight-toggle');
      if (!target) return;
      if (target.id === 'marketing-spotlight-toggle') { state.paused = !state.paused; schedule(); return; }
      if (target.dataset.mkStep) { const step = Number(target.dataset.mkStep); state.index = (state.index + step + SLIDES.length) % SLIDES.length; render(step); return; }
      const next = Number(target.dataset.mkGo);
      const direction = next >= state.index ? 1 : -1;
      state.index = next;
      render(direction);
    });
    spotlight.addEventListener('mouseenter', () => { state.hover = true; schedule(); });
    spotlight.addEventListener('mouseleave', () => { state.hover = false; schedule(); });
    spotlight.addEventListener('focusin', () => { state.focus = true; schedule(); });
    spotlight.addEventListener('focusout', event => { if (!spotlight.contains(event.relatedTarget)) { state.focus = false; schedule(); } });
    document.addEventListener('visibilitychange', schedule);
    $('marketing-spotlight-dots').addEventListener('animationend', event => { if (event.animationName === 'mk-fill') advance(); });
    render(1);
  }

  // In-page links must not reach the app's hash router while signed out.
  function bindNavigation() {
    const page = $('auth-screen');
    if (!page) return;
    page.addEventListener('click', event => {
      const link = event.target.closest?.('a[data-marketing-jump]');
      if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const id = link.dataset.marketingJump;
      const behavior = reducedMotion() ? 'auto' : 'smooth';
      if (id === 'top') window.scrollTo?.({ top: 0, behavior });
      else $(id)?.scrollIntoView?.({ behavior, block: 'start' });
      if (link.hasAttribute('data-marketing-signin')) {
        const name = $('auth-name');
        (name && !name.closest('[hidden]') ? name : $('auth-email'))?.focus?.({ preventScroll: true });
      }
    });
    const links = [...document.querySelectorAll('.marketing-links a[data-marketing-jump]')];
    if (typeof IntersectionObserver !== 'function' || !links.length) return;
    const observer = new IntersectionObserver(entries => {
      entries.filter(entry => entry.isIntersecting).forEach(entry => {
        links.forEach(link => {
          const current = link.dataset.marketingJump === entry.target.id;
          link.classList.toggle('is-current', current);
          if (current) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    links.forEach(link => { const section = $(link.dataset.marketingJump); if (section) observer.observe(section); });
  }

  function start() { buildSpotlight(); bindNavigation(); }
  window.FinanceMarketing = { start, slides: SLIDES, go: index => { state.index = (index + SLIDES.length) % SLIDES.length; render(1); }, current: () => state.index };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
