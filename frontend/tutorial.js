// Tutorials: narrated, animated walkthroughs rendered as HTML "video" scenes on a scalable 16:9 canvas.
(function () {
  const W = 800, H = 450;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const storage = {
    get: key => { try { return window.localStorage?.getItem(key); } catch { return null; } },
    set: (key, value) => { try { window.localStorage?.setItem(key, value); } catch { /* private mode */ } }
  };
  const ICONS = {
    play: '<path d="m8 5 11 7-11 7Z" fill="currentColor"/>', pause: '<path d="M8 5v14M16 5v14"/>',
    prev: '<path d="M6 5v14M18 6l-9 6 9 6Z"/>', next: '<path d="M18 5v14M6 6l9 6-9 6Z"/>',
    replay: '<path d="M4 12a8 8 0 1 0 3-6.2L4 8"/><path d="M4 3v5h5"/>', full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    voice: '<path d="M4 10v4h4l5 4V6L8 10Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    mute: '<path d="M4 10v4h4l5 4V6L8 10Z"/><path d="m17 9 5 6M22 9l-5 6"/>', check: '<path d="m5 12 5 5 9-10"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  };
  const icon = (name, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;

  // ---------- mock building blocks (canvas pixels) ----------
  const chip = (n, text) => `<div class="tm-chip"><b>${n}</b>${esc(text)}</div>`;
  const at = (seconds, extra = '') => `style="--d:${seconds}s;${extra}"`;
  const cursor = (to, delay, from = '') => `<span class="tut-cursor" data-to="${to}" ${from ? `data-from="${from}"` : ''} ${at(delay)}><i></i></span>`;
  const toast = (text, delay) => `<div class="tm-toast tut-in" ${at(delay)}>${icon('check', 14)}${esc(text)}</div>`;
  const intro = (eyebrow, title, sub, tiles) => `<div class="tm-intro">
    <p class="tut-in" ${at(0.2)}>${esc(eyebrow)}</p><h2 class="tut-in" ${at(0.5)}>${esc(title)}</h2><span class="tut-in" ${at(0.9)}>${esc(sub)}</span>
    <div class="tm-intro-tiles">${tiles.map((tile, index) => `<i class="tut-pop" ${at(1.3 + index * 0.25)}>${tile}</i>`).join('')}</div></div>`;
  const outro = (title, sub, cta) => `<div class="tm-intro tm-outro">
    <div class="tm-outro-check tut-pop" ${at(0.3)}>${icon('check', 34)}</div>
    <h2 class="tut-in" ${at(0.6)}>${esc(title)}</h2><span class="tut-in" ${at(0.9)}>${esc(sub)}</span>
    <em class="tut-in" ${at(1.4)}>${esc(cta)} ${icon('arrow', 16)}</em></div>`;

  const DEBTS = [
    { e: '💳', name: 'Visa Signature', type: 'Credit card', bal: '$6,200', apr: '24.9%', min: '$185', p: 22 },
    { e: '🛍️', name: 'Store card', type: 'Credit card', bal: '$900', apr: '19.9%', min: '$35', p: 58 },
    { e: '🚗', name: 'Car loan', type: 'Auto loan', bal: '$11,800', apr: '6.4%', min: '$310', p: 41 },
    { e: '🎓', name: 'Student loan', type: 'Student loan', bal: '$18,500', apr: '4.5%', min: '$210', p: 30 }
  ];
  const debtCard = (debt, { delay = null, cls = '', id = '', extra = '' } = {}) => `<div class="tm-debt ${cls}${delay != null ? ' tut-in' : ''}" ${delay != null ? at(delay) : ''} ${id ? `data-id="${id}"` : ''}>
    <div class="tm-debt-top"><span class="tm-emoji">${debt.e}</span><div><b>${esc(debt.name)}</b><small>${esc(debt.type)}</small></div>${extra}</div>
    <div class="tm-debt-nums"><div><small>Balance</small><b>${debt.bal}</b></div><div><small>APR</small><b>${debt.apr}</b></div><div><small>Minimum</small><b>${debt.min}</b></div></div>
    <div class="tm-bar"><span style="width:${debt.p}%"></span></div></div>`;
  const switchEl = (on = true, flipAt = null, id = '') => `<span class="tm-switch${on ? ' is-on' : ''}${flipAt != null ? ' tm-flip-off' : ''}" ${flipAt != null ? at(flipAt) : ''} ${id ? `data-id="${id}"` : ''}><i></i></span>`;
  const strat = (name, tag, date, interest, target, { active = false, reco = false, pro = false, id = '', ringOut = null, ringIn = null, unit = ' interest' } = {}) => `<div class="tm-strat${pro ? ' is-locked' : ''}" ${id ? `data-id="${id}"` : ''}>
    ${active ? `<span class="tm-ring${ringOut != null ? ' tut-off' : ''}" ${ringOut != null ? at(ringOut) : ''}></span>` : ''}${ringIn != null ? `<span class="tm-ring tut-on" ${at(ringIn)}></span>` : ''}
    <div class="tm-strat-head"><b>${esc(name)}</b>${pro ? '<span class="tm-pro">PRO</span>' : reco ? '<span class="tm-reco">Recommended</span>' : ''}</div>
    <small>${esc(tag)}</small>
    ${pro ? '<em class="tm-strat-meta">Unlock to compare</em>' : `<em class="tm-strat-meta"><b data-id="${id}-date">${date}</b><i data-id="${id}-int">${interest}${unit}</i></em><span class="tm-first">Extra goes to <b>${esc(target)}</b> first</span>`}
  </div>`;
  const weekCard = (title, amount, { tone = '', paid = false, badge = '', balance = '', id = '', delay = null, dashed = false } = {}) => `<div class="tm-pay${paid ? ' is-paid' : ''}${tone ? ` is-${tone}` : ''}${dashed ? ' is-flex' : ''}${delay != null ? ' tut-pop' : ''}" ${delay != null ? at(delay) : ''} ${id ? `data-id="${id}"` : ''}>
    <b>${esc(title)}</b><strong>${amount}</strong>${badge ? `<span class="tm-badge tm-badge-${badge.toLowerCase()}">${esc(badge)}</span>` : ''}${balance ? `<small>Bal ${balance}</small>` : ''}</div>`;
  const week = (days, opts = {}) => `<div class="tm-week${opts.cls ? ` ${opts.cls}` : ''}">${days.map(([label, num, cards = '', today]) => `<div class="tm-day${today ? ' is-today' : ''}"><span>${label} <b>${num}</b></span>${cards}</div>`).join('')}</div>`;
  // A tick box; `on` = already ticked, `onAt` = ticks itself at that second.
  const check = ({ on = false, onAt = null, id = '' } = {}) => `<span class="tm-check" ${id ? `data-id="${id}"` : ''}>${on ? `<i>${icon('check', 11)}</i>` : onAt != null ? `<i class="tut-on" ${at(onAt)}>${icon('check', 11)}</i>` : ''}</span>`;
  const swap = (from, to, t) => `<span class="tm-swap-inline tm-swap-left"><span class="tut-off" ${at(t)}>${from}</span><span class="tut-on" ${at(t)}>${to}</span></span>`;
  const txHead = (fixedLabel = 'Fixed / Income') => `<div class="tm-tr tm-th"><span>Date</span><span>Description</span><span>Category</span><span>${fixedLabel}</span><span>Pays by</span><span>Amount</span></div>`;
  const txRow = ({ date, desc, cat = '', tick = '', pay = '', payHtml = '', amt, credit = false, cls = '', delay = null, id = '' }) => `<div class="tm-tr${cls ? ` ${cls}` : ''}${delay != null ? ' tut-in' : ''}" ${delay != null ? at(delay) : ''} ${id ? `data-id="${id}"` : ''}>
    <span>${date}</span><b>${desc}</b><span class="tm-select">${cat || 'Uncategorized'}</span><span class="tm-tick">${tick}</span><span>${payHtml || (pay ? `<i class="tm-badge tm-badge-${pay.toLowerCase()}">${pay}</i>` : '<i class="tm-unset">—</i>')}</span><strong class="${credit ? 'is-in' : 'is-out'}">${credit ? '+' : '−'}${amt}</strong></div>`;
  const compare = (cols, delay = 0.4) => `<div class="tm-compare tm-compare-${cols.length}">${cols.map((col, index) => `<div class="tm-compare-col tut-in${col.cls ? ` ${col.cls}` : ''}" ${at(delay + index * 0.9)}>
    <span class="tm-emoji">${col.e}</span><b>${esc(col.title)}</b><small>${esc(col.when)}</small>
    <ul>${col.asks.map(ask => `<li>“${esc(ask)}”</li>`).join('')}</ul></div>`).join('')}</div>`;
  const catCard = (e, name, amount, w, delay, opts = {}) => `<div class="tm-cat tut-in${opts.cls ? ` ${opts.cls}` : ''}" ${at(delay)} ${opts.id ? `data-id="${opts.id}"` : ''}><span class="tm-emoji">${e}</span><b>${esc(name)}</b><strong>${amount}</strong><div class="tm-bar"><span class="tut-grow" ${at(delay + 0.3, `--w:${w}%`)}></span></div><small>${esc(opts.note || '')}</small></div>`;
  // `closeAt` fades the dialog out after its button is clicked so the confirmation toast is readable.
  const similar = (title, copy, rows, button, delay, closeAt) => `<div ${closeAt ? `class="tut-off" ${at(closeAt)}` : ''}><div class="tm-dialog tm-similar tut-pop" ${at(delay)}>
    <b>${esc(title)}</b><small>${copy}</small>
    ${rows.map(([text, sub, on = true]) => `<div class="tm-similar-row">${check({ on })}<span>${esc(text)}<small>${sub}</small></span></div>`).join('')}
    <span class="tm-btn tm-btn-primary" data-id="similar-apply">${esc(button)}</span></div></div>`;
  const PAGES = {
    transactions: { e: '🧾', title: 'Transactions', when: 'For detail: one line, one charge.', asks: ['What was that $42.50?', 'Did my refund land?', 'Fix this one row.'] },
    categories: { e: '🏷️', title: 'Categories', when: 'For patterns: what your money is for.', asks: ['Where does my money go?', 'Is dining creeping up?', 'Which month cost most?'] },
    fixed: { e: '📌', title: 'Fixed bills & income', when: 'For timing: when money moves.', asks: ['Can I cover rent on the 1st?', 'When is my next payday?', 'Which bills need me?'] }
  };

  // ---------- tutorials ----------
  const TUTORIALS = [
    {
      id: 'debt', title: 'Your debt-free plan', blurb: 'Pro: assess breathing room, test spending changes and choose a sustainable payoff strategy.', emoji: '🏁',
      cta: { label: 'Open my debt-free plan', view: 'payoff' },
      scenes: [
        { id: 'intro', title: 'Welcome', caption: 'Your debt-free plan gathers cards and loans, evaluates recorded cash flow and compares projected paths to zero. These are estimates, not payments or guaranteed savings.',
          render: () => intro('TUTORIAL', 'Your debt-free plan', 'Every balance. One plan. A modeled finish line.', ['💳', '🚗', '🎓', '🏁']) },
        { id: 'debts', title: 'Add every debt', caption: 'Start by adding each debt with its balance, APR and minimum payment. Cards, car loans, student loans and mortgages all work.',
          render: () => `${chip(1, 'Add every debt')}
            <div class="tm-row-head"><div><h3>Your debts</h3><small>Balances, rates and minimums in one place</small></div><span class="tm-btn tm-btn-primary" data-id="add">+ Add debt or loan</span></div>
            <div class="tm-grid-2">${DEBTS.map((debt, index) => debtCard(debt, { delay: 1.5 + index * 0.45, extra: switchEl(true) })).join('')}</div>
            ${cursor('add', 0.3)}` },
        { id: 'include', title: 'Include and focus', caption: 'Switch a debt off to keep paying it normally outside the plan. Star a debt if you want it gone first, whatever the math says.',
          render: () => `${chip(2, 'Include and focus')}
            <div class="tm-row-head"><div><h3>Your debts</h3><small>Switch off to exclude · star to pay first</small></div></div>
            <div class="tm-grid-2">
              ${debtCard(DEBTS[0], { extra: switchEl(true) })}
              ${debtCard(DEBTS[1], { extra: `<span class="tm-star tut-pop" ${at(3.9)} data-id="star">★</span>${switchEl(true)}`, cls: 'tm-focus-at', id: 'store' })}
              ${debtCard(DEBTS[2], { extra: switchEl(true) })}
              ${debtCard(DEBTS[3], { extra: switchEl(true, 1.9, 'sw'), cls: 'tm-dim-at' })}
            </div>
            <span class="tm-tag tut-pop" ${at(2.2, 'right:44px;bottom:40px')}>Outside the program</span>
            <span class="tm-tag tm-tag-gold tut-pop" ${at(4.2, 'right:420px;top:118px')}>Pay first</span>
            ${cursor('sw', 0.6)}${cursor('star', 2.8, 'sw')}` },
        { id: 'strategy', title: 'Choose a strategy', caption: 'Compare the same budget across strategies. Avalanche targets the highest rate; snowball targets the smallest balance. Recommended means lowest modeled interest among available strategies. Compare the first finish too. Funded strategies cover minimums and roll freed payments forward; a starred debt overrides the order.',
          render: () => `${chip(3, 'Choose a strategy')}
            <div class="tm-row-head"><div><h3>Choose your strategy <span class="tm-using"><span class="tut-off" ${at(2.1)}>Using Avalanche</span><span class="tut-on" ${at(2.1)}>Using Snowball</span></span></h3><small>Dates and interest at your $950/mo budget</small></div></div>
            <div class="tm-strats">
              ${strat('Avalanche', 'Highest APR first', 'Mar 2028', '$3,140', 'Visa Signature', { active: true, reco: true, id: 'ava', ringOut: 2.1 })}
              ${strat('Snowball', 'Smallest balance first', 'Apr 2028', '$3,385', 'Store card', { id: 'snow', ringIn: 2.1 })}
              ${strat('Interest cost', 'Biggest interest bill first', '', '', '', { pro: true })}
              ${strat('Cash-flow', 'Free up monthly payments', '', '', '', { pro: true })}
            </div>
            ${toast('Switched to Snowball. Your plan and calendar are updated.', 2.6)}
            ${cursor('snow', 0.6)}` },
        { id: 'dates', title: 'What the dates mean', caption: 'Each card shows the month you would be debt-free and the total interest you would pay, simulated at your current monthly budget. When two strategies pay your debts in the same order, their results match, so switching changes nothing until your balances differ.',
          render: () => `${chip(4, 'What the dates mean')}
            <div class="tm-explain">
              <div class="tm-big-strat"><b>Avalanche</b><small>Highest APR first</small><strong class="tm-hl" ${at(0.8)}>Mar 2028</strong><em class="tm-hl" ${at(2.2)}>$3,140 interest</em></div>
              <div class="tm-callouts">
                <p class="tut-in" ${at(1)}><span>1</span><b>Debt-free month</b>When the last balance hits zero if you stick to the plan.</p>
                <p class="tut-in" ${at(2.4)}><span>2</span><b>Total interest</b>Everything you would pay lenders on the way there.</p>
                <p class="tut-in" ${at(3.8)}><span>3</span><b>Your budget drives both</b>Each strategy is simulated month by month at the same $950/mo.</p>
              </div>
            </div>
            <div class="tm-note tut-in" ${at(5.4)}>ⓘ Same payoff order, same result. If Avalanche and Snowball target the same debt first, their dates match and switching won't change anything yet.</div>` },
        { id: 'assessment', title: 'Check your breathing room', caption: 'Your starting point separates recorded inflows, spending, savings goals and existing extra payments. Suggested increases need three completed months with inflows and outflows. The tighter month limits the allowance, with a cushion of at least $100 or ten percent of spending. Missing accounts or irregular income still need your judgment.',
          render: () => `${chip(5, 'Your starting point')}
            ${compare([
              { e: '1', title: 'Review the evidence', when: 'Three completed months', asks: ['Are all accounts imported?', 'Are deposits recurring?', 'Are minimums represented?'] },
              { e: '2', title: 'Protect breathing room', when: 'Average and tightest month', asks: ['Reserve goals and current extras.', 'Keep a planning cushion.', 'No automatic budget increase.'] }
            ])}` },
        { id: 'budget', title: 'Set your budget', caption: 'Set a monthly debt budget that covers minimums and fits your actual cash flow. Anything above minimums is extra. Saving a budget changes projections, not bank payments. Higher current-month flexible commitments are reserved in the assessment; a temporary reduction does not create permanent headroom.',
          render: () => `${chip(5, 'Set your monthly budget')}
            <div class="tm-split">
              <div class="tm-panel">
                <small>MONTHLY DEBT BUDGET</small>
                <div class="tm-swap-num"><b class="tut-off" ${at(2)}>$950</b><b class="tut-on" ${at(2)}>$1,150</b></div>
                <div class="tm-slider"><span class="tm-slider-fill"></span><i class="tm-knob" data-id="knob"></i><em>Minimums $740</em></div>
                <div class="tm-kv"><span>Minimums</span><b>$740</b></div>
                <div class="tm-kv"><span>Extra each month</span><b class="tm-swap-inline"><span class="tut-off" ${at(2)}>$210</span><span class="tut-on" ${at(2)}>$410</span></b></div>
              </div>
              <div class="tm-panel tm-panel-dark">
                <small>DEBT-FREE</small>
                <div class="tm-swap-num"><b class="tut-off" ${at(2.3)}>Mar 2028</b><b class="tut-on" ${at(2.3)}>Aug 2027</b></div>
                <span class="tm-pill tut-pop" ${at(2.8)}>⚡ Saves $1,020 and 7 months</span>
                <svg class="tm-chart" viewBox="0 0 320 120" aria-hidden="true"><path class="tm-chart-base" d="M0 10 C 90 30, 200 70, 320 104"/><path class="tm-chart-old" d="M0 10 C 70 40, 150 90, 250 112"/><path class="tm-chart-new tut-draw" ${at(2.4)} d="M0 10 C 60 50, 120 100, 190 112"/></svg>
              </div>
            </div>
            ${cursor('knob', 0.5)}` },
        { id: 'experiments', title: 'Find your next extra dollar', caption: 'Pick one spending experiment, not a complete overhaul. Review activity before trying ten percent less in a category. Monthly and weekly ceilings are hypothetical. The $25, $50 and $100 scenarios are independent, not amounts to add together. Only redirect money you actually free up.',
          render: () => `${chip(6, 'Find your next extra dollar')}
            <div class="tm-split">
              <div class="tm-panel"><small>ILLUSTRATIVE SPENDING EXPERIMENT</small><h3>Dining</h3><div class="tm-kv"><span>Observed average</span><b>$500/mo</b></div><div class="tm-kv"><span>Try 10% less</span><b>$50/mo</b></div><div class="tm-kv"><span>Trial ceiling</span><b>$450/mo</b></div><span class="tm-btn">Review activity</span></div>
              <div class="tm-panel tm-panel-dark"><small>TEST BEFORE COMMITTING</small><h3>+$25 / +$50 / +$100</h3><p>Each scenario uses the current debt budget as its starting point.</p><p>Check funding support, payoff timing and interest separately.</p></div>
            </div>` },
        { id: 'guidance', title: 'Guidance and checkpoints', caption: 'Guidance explains rate costs and focus tradeoffs. Make the next step visible shows projected principal reduction and your first modeled payoff, not recorded achievements. Review one sustainable change each week. Keep an emergency reserve suited to your circumstances; seek credit counseling if minimums are difficult.',
          render: () => `${chip(6, 'Follow the guidance')}
            <div class="tm-row-head"><div><h3>Guidance</h3><small>Based on your rates, balances and recent cash flow</small></div></div>
            <ul class="tm-guide">
              <li class="is-warn tut-in" ${at(0.6)}><i>!</i><div><b>Visa Signature is your most expensive money</b><span>At 24.9% APR it costs about $129 a month in interest.</span></div></li>
              <li class="is-good tut-in" ${at(1.8)}><i>✓</i><div><b>Compare your next three modeled months</b><span>Projected checkpoints, not payments already made.</span></div></li>
              <li class="is-info tut-in" ${at(3)}><i>i</i><div><b>Your focus on Store card costs about $18</b><span>A fair trade if clearing it matters to you.</span></div></li>
              <li class="is-info tut-in" ${at(4.2)}><i>i</i><div><b>Protect an emergency reserve</b><span>Choose an amount suited to your risks and obligations.</span></div></li>
            </ul>` },
        { id: 'flex', title: 'Flex a tight month', caption: 'Your plan payments land on the dashboard calendar next to bills and paydays. Tight month? Tap the extra payment and lower it for this month only. The plan adjusts automatically.',
          render: () => `${chip(7, 'Flex a tight month')}
            <div class="tm-row-head"><div><h3>Upcoming payments</h3><small>Bills, paydays and your plan, on the day they happen</small></div></div>
            ${week([['Sun', 12], ['Mon', 13, weekCard('Rent', '$1,450', { paid: true, balance: '$2,310' })], ['Tue', 14, weekCard('Visa minimum', '$185', { badge: 'Auto', balance: '$2,125' }), true], ['Wed', 15], ['Thu', 16, weekCard('Payday', '+$2,100', { tone: 'income', balance: '$4,225' })], ['Fri', 17, weekCard('Extra · Visa', '$240', { dashed: true, id: 'extra', balance: '$3,985' })], ['Sat', 18]])}
            <div class="tm-dialog tut-pop" ${at(2.1)}>
              <b>Flex this month</b><small>Extra payment · Visa Signature</small>
              <div class="tm-input"><span class="tut-off" ${at(3.2)}>$240</span><span class="tut-on" ${at(3.2)}>$120</span></div>
              <small>Planned $240 · applies to October only</small>
              <span class="tm-btn tm-btn-primary">Save for this month</span>
            </div>
            ${cursor('extra', 0.5)}` },
        { id: 'pro', title: 'What-if and your own order', caption: 'With MyFinance Pro you can test a raise, a bonus or a lump sum before you commit, and set your own payoff order. All debt and savings planning tools require Pro. Open your plan and take the first step.',
          render: () => `${chip(8, 'Go further with Pro')}
            <div class="tm-split">
              <div class="tm-panel tm-panel-pro tut-in" ${at(0.4)}>
                <small><span class="tm-pro">PRO</span> WHAT-IF</small>
                <div class="tm-kv"><span>Extra per month</span><b>+$100</b></div>
                <div class="tm-kv"><span>One-time lump sum</span><b>$2,000</b></div>
                <div class="tm-result tut-pop" ${at(1.6)}><b>Debt-free Jan 2027</b><span>7 months sooner · saves $1,480</span></div>
              </div>
              <div class="tm-panel tut-in" ${at(0.8)}>
                <small><span class="tm-pro">PRO</span> MY ORDER</small>
                <ol class="tm-order"><li>🛍️ Store card<i>↑↓</i></li><li class="tm-move-up" ${at(2.6)}>🚗 Car loan<i>↑↓</i></li><li class="tm-move-down" ${at(2.6)}>💳 Visa Signature<i>↑↓</i></li><li>🎓 Student loan<i>↑↓</i></li></ol>
              </div>
            </div>` },
        { id: 'done', title: 'You are ready', caption: 'You are ready. Add your debts, pick a strategy and set a budget you can keep.',
          render: () => outro("You're ready", 'Add debts · pick a strategy · set your budget', 'Open your debt-free plan') }
      ]
    },
    {
      id: 'goals', title: 'Savings goals', blurb: 'Create goals, see where your surplus goes and keep every goal on track.', emoji: '🎯',
      cta: { label: 'Open my goals', view: 'goals' },
      scenes: [
        { id: 'intro', title: 'Welcome', caption: 'With Pro, savings goals give every dollar of surplus a job, next to your bills and your debt-free plan.',
          render: () => intro('TUTORIAL', 'Savings goals', 'Make room for what matters.', ['🛡️', '✈️', '💻', '🎯']) },
        { id: 'create', title: 'Create a goal', caption: 'Create a goal with an icon, a target amount and an optional date. Add anything you have already saved so progress starts in the right place.',
          render: () => `${chip(1, 'Create a goal')}
            <div class="tm-dialog tm-dialog-center tut-pop" ${at(0.3)}>
              <b>New savings goal</b>
              <div class="tm-emojis"><i class="is-on">🛡️</i><i>✈️</i><i>🚗</i><i>🏠</i><i>🎓</i><i>💻</i></div>
              <div class="tm-field tut-in" ${at(1.2)}><small>Name</small><span>Emergency fund</span></div>
              <div class="tm-fields"><div class="tm-field tut-in" ${at(2)}><small>Target</small><span>$5,000</span></div><div class="tm-field tut-in" ${at(2.8)}><small>Target date</small><span>Jun 2027</span></div></div>
              <div class="tm-field tut-in" ${at(3.6)}><small>Already saved</small><span>$1,200</span></div>
              <span class="tm-btn tm-btn-primary tut-in" ${at(4.4)} data-id="save">Save goal</span>
            </div>${cursor('save', 4.6)}` },
        { id: 'surplus', title: 'Where your surplus goes', caption: 'Typical surplus uses up to three completed months of imported history, excluding transfers and reserving debt minimums missing from spending. The plan allocates debt extra before savings goals. Recorded inflows are not verified wages, and an average does not guarantee affordability.',
          render: () => `${chip(2, 'Where your surplus goes')}
            <div class="tm-panel tm-flow">
              <small>TYPICAL MONTHLY SURPLUS</small><strong>$1,050<em>/mo</em></strong>
              <div class="tm-flow-bar"><span class="is-debt tut-grow" ${at(1, '--w:20%')}></span><span class="is-goal tut-grow" ${at(2, '--w:57%')}></span><span class="is-free tut-grow" ${at(3, '--w:23%')}></span></div>
              <div class="tm-legend"><span class="is-debt tut-in" ${at(1.2)}><i></i>Debt extra <b>$210</b></span><span class="is-goal tut-in" ${at(2.2)}><i></i>Goals <b>$600</b></span><span class="is-free tut-in" ${at(3.2)}><i></i>Still free <b>$240</b></span></div>
            </div>` },
        { id: 'strategy', title: 'Choose how goals are funded', caption: 'Choose how the goal budget is shared. Priority order funds your most important goal first. Nearest deadline protects the soonest date. Balanced moves everything together. All are included in Pro.',
          render: () => `${chip(3, 'Choose how goals are funded')}
            <div class="tm-strats tm-strats-3">
              ${strat('Priority order', 'Most important first', 'Emergency', 'funded first', 'Emergency fund', { active: true, reco: false, id: 'prio', ringOut: 2, unit: '' })}
              ${strat('Nearest deadline', 'Soonest date first', 'Vacation', 'funded first', 'Vacation', { id: 'dead', ringIn: 2, unit: '' })}
              ${strat('Balanced', 'Everything moves together', 'Shared', 'monthly budget', 'All included goals', { unit: '' })}
            </div>${toast('Switched to Nearest deadline. Goal amounts are updated.', 2.5)}${cursor('dead', 0.6)}` },
        { id: 'status', title: 'Stay on track', caption: 'Each goal shows its monthly amount and status. If one falls behind, you will see exactly how much more it needs each month, here and on your dashboard.',
          render: () => `${chip(4, 'Stay on track')}
            <div class="tm-goals">
              <div class="tm-goal tut-in" ${at(0.4)}><span class="tm-emoji">🛡️</span><b>Emergency fund</b><small>$1,200 of $5,000 · $280/mo</small><div class="tm-bar"><span class="tut-grow" ${at(0.8, '--w:24%')}></span></div><em class="is-good">On track</em></div>
              <div class="tm-goal tut-in" ${at(1)}><span class="tm-emoji">✈️</span><b>Vacation</b><small>$900 of $3,000 · $150/mo</small><div class="tm-bar"><span class="tut-grow" ${at(1.4, '--w:30%')}></span></div><em class="is-warn">Behind</em><p class="tut-in" ${at(2.6)}>Needs $60 more a month to make June.</p></div>
              <div class="tm-goal tut-in" ${at(1.6)}><span class="tm-emoji">💻</span><b>New laptop</b><small>$1,400 of $1,400</small><div class="tm-bar"><span class="tut-grow" ${at(2, '--w:100%')}></span></div><em class="is-good">Funded</em></div>
            </div>` },
        { id: 'flex', title: 'Flex and record savings', caption: 'Goal contributions appear on the calendar, where you can trim this month without changing the long-term allocation. After actually saving money, record it once to update progress. Recording savings does not transfer money, and importing a bank transfer does not automatically record a goal contribution.',
          render: () => `${chip(5, 'Flex and record savings')}
            ${week([['Mon', 13], ['Tue', 14, '', true], ['Wed', 15], ['Thu', 16, weekCard('Payday', '+$2,100', { tone: 'income' })], ['Fri', 17, weekCard('Vacation savings', '$150', { dashed: true, tone: 'goal' })], ['Sat', 18], ['Sun', 19]])}
            <div class="tm-goal tm-goal-wide tut-in" ${at(1.4)}><span class="tm-emoji">✈️</span><b>Vacation</b><small><span class="tut-off" ${at(3.2)}>$900 of $3,000</span><span class="tut-on" ${at(3.2)}>$1,050 of $3,000</span></small><div class="tm-bar"><span class="tm-grow-step" ${at(3.2)}></span></div><span class="tm-btn" data-id="record">Record savings</span></div>
            ${cursor('record', 1.8)}` },
        { id: 'done', title: 'You are ready', caption: 'That is it. Create your first goal and let the plan do the math.',
          render: () => outro("You're ready", 'Create a goal · choose a strategy · stay on track', 'Open your goals') }
      ]
    },
    {
      id: 'dashboard', title: 'Your dashboard', blurb: 'Read your insights, the week ahead, paydays and which bills need you.', emoji: '✨',
      cta: { label: 'Go to my dashboard', view: 'dashboard' },
      scenes: [
        { id: 'intro', title: 'Welcome', caption: 'Your dashboard opens with what matters today: a greeting, timely insights and the week ahead.',
          render: () => intro('TUTORIAL', 'Your dashboard', 'Know where you stand. Choose what comes next.', ['📅', '💵', '✅']) },
        { id: 'insights', title: 'Rotating insights', caption: 'Insights rotate through anything that needs you: a day you might run short, bills due soon, payday, goals and your debt-free date. Hover to pause, or use the arrows.',
          render: () => `${chip(1, 'Rotating insights')}
            <div class="tm-hero">
              <small>WEDNESDAY, OCTOBER 14</small><h3>Good evening, Alex</h3><p>One thing needs your attention today.</p>
              <div class="tm-hero-card">
                <div class="tut-off" ${at(3.2)}><em class="is-bad">NEEDS ATTENTION</em><b>You could run short Tuesday</b><span>After Rent on the 20th, your balance drops to −$180.</span></div>
                <div class="tut-on" ${at(3.2)}><em class="is-good">NICE WORK</em><b>Payday in 2 days</b><span>Expect about $2,100 from ACME on Friday (every other week).</span></div>
                <div class="tm-dots"><i class="tm-dot-fill" ${at(0)}></i><i class="tm-dot-fill" ${at(3.2)}></i><i></i><i></i></div>
              </div>
            </div>` },
        { id: 'glance', title: 'Today at a glance', caption: 'Today at a glance shows recorded balance, next payday, bills for the next 30 days plus earlier pending bills this month, and your projected low point. Calculation information opens a dialog explaining the number. These estimates depend on current account data, not a live bank connection.',
          render: () => `${chip(2, 'Today at a glance')}
            <div class="tm-pulse">
              ${[['Balance', '$2,310.42', 'Latest recorded'], ['Next payday', '$2,100', 'In 2 days · the 16th'], ['Bills in next 30 days', '$2,264', '6 payments, including overdue'], ['Lowest point ahead', '$412', 'On Oct 20'], ['Debt-free', 'Mar 2028', 'On your current plan']]
                .map(([label, value, note], index) => `<div class="tut-in" ${at(0.5 + index * 0.7)}><span>${label}</span><b>${value}</b><small>${note}</small></div>`).join('')}
            </div>` },
        { id: 'week', title: 'The week ahead', caption: 'Upcoming payments always look 30 days forward, week by week, and extend backward to earlier unpaid bills. Each card shows the projected balance after it clears. Paid fixed bills stay accessible in the history drawer above the timeline.',
          render: () => `${chip(3, 'The week ahead')}
            <div class="tm-drawer tut-in" ${at(0.4)}>Paid fixed bills this month · Rent paid $1,450 <span>⌄</span></div>
            ${week([['Sun', 12], ['Mon', 13], ['Tue', 14, weekCard('Netflix', '$15', { badge: 'Auto', balance: '$2,295', delay: 0.9 }), true], ['Wed', 15, weekCard('City Water', '$64', { badge: 'Manual', balance: '$2,231', delay: 1.4 })], ['Thu', 16, weekCard('Payday', '+$2,100', { tone: 'income', balance: '$4,331', delay: 1.9 })], ['Fri', 17], ['Sat', 18, weekCard('Gym', '$40', { badge: 'Auto', balance: '$4,291', delay: 2.4 })]])}` },
        { id: 'paydays', title: 'Paydays and manual bills', caption: 'Paydays are detected from your history, weekly, every other week or monthly, and counted in the running balance. Manual bills are flagged so you know which ones need you.',
          render: () => `${chip(4, 'Paydays and manual bills')}
            <div class="tm-split">
              <div class="tm-panel tut-in" ${at(0.4)}><small>INCOME DETECTED</small><b class="tm-lg">ACME PAYROLL</b><span class="tm-pill tm-pill-light">Every other Thursday · $2,100</span><div class="tm-dates">${['Oct 2', 'Oct 16', 'Oct 30'].map((d, i) => `<i class="tut-pop" ${at(1 + i * 0.4)}>${d}</i>`).join('')}</div></div>
              <div class="tm-panel tut-in" ${at(1.2)}><small>WHO PAYS IT?</small>
                <div class="tm-kv"><span>Netflix</span><span class="tm-badge tm-badge-auto">Auto</span></div>
                <div class="tm-kv tm-hl" ${at(2.6)}><span>City Water</span><span class="tm-badge tm-badge-manual">Manual</span></div>
                <div class="tm-kv"><span>Gym</span><span class="tm-badge tm-badge-auto">Auto</span></div>
                <p class="tm-hint tut-in" ${at(3)}>Set this on any fixed bill from the Transactions page.</p></div>
            </div>` },
        { id: 'list', title: 'Calendar or list', caption: 'Prefer a list? Switch to List any time. Earlier pending bills stay above Today. Expand Paid fixed bills this month above the timeline for payments and transaction links; monthly income and expense charts are further down.',
          render: () => `${chip(5, 'Calendar or list')}
            <div class="tm-row-head"><div><h3>Upcoming payments</h3></div><span class="tm-toggle"><i class="tut-off" ${at(1.6)}>Calendar</i><i class="tut-on" ${at(1.6)} data-id="list">List</i></span></div>
            <div class="tm-drawer tut-in" ${at(0.4)}>Paid fixed bills this month <span>⌄</span></div>
            <div class="tm-swap-block">
              <div class="tut-off" ${at(1.8)}>${week([['Mon', 13], ['Tue', 14, weekCard('Netflix', '$15', { badge: 'Auto' }), true], ['Wed', 15, weekCard('City Water', '$64', { badge: 'Manual' })], ['Thu', 16, weekCard('Payday', '+$2,100', { tone: 'income' })], ['Fri', 17], ['Sat', 18], ['Sun', 19]])}</div>
              <ul class="tm-list tut-on" ${at(1.8)}>${[['Tue 14', 'Netflix', 'Auto', '$15'], ['Wed 15', 'City Water', 'Manual', '$64'], ['Thu 16', 'Payday', '', '+$2,100'], ['Sat 18', 'Gym', 'Auto', '$40']].map(([d, n, b, a]) => `<li><span>${d}</span><b>${n}</b>${b ? `<i class="tm-badge tm-badge-${b.toLowerCase()}">${b}</i>` : '<i></i>'}<strong>${a}</strong></li>`).join('')}</ul>
            </div>
            ${cursor('list', 0.4)}` },
        { id: 'done', title: 'You are ready', caption: 'That is the tour. Check in each morning and let the insights tell you what needs you.',
          render: () => outro("You're ready", 'Insights · the week ahead · paydays', 'Go to your dashboard') }
      ]
    },
    {
      id: 'fixed', title: 'Fixed bills & income', blurb: 'Teach MyFinance your rhythm: fixed bills, real paydays and who pays what.', emoji: '📌',
      cta: { label: 'Mark my fixed bills', view: 'transactions' },
      scenes: [
        { id: 'intro', title: 'Welcome', caption: 'Fixed bills and regular income tell MyFinance when money moves. Mark them once and your calendar, payday forecast and low-balance warnings come to life.',
          render: () => intro('TUTORIAL', 'Fixed bills & income', 'Teach it your rhythm once. Get a forecast every day.', ['🏠', '📱', '💵', '📅']) },
        { id: 'what', title: 'What counts as fixed', caption: 'A fixed bill repeats at about the same amount on about the same day: rent, phone, insurance, streaming. Regular income is pay you can count on. Everything else is everyday spending that changes month to month.',
          render: () => `${chip(1, 'What counts as fixed')}
            <div class="tm-split tm-split-tight">
              <div class="tm-panel tut-in" ${at(0.4)}><small>📌 FIXED · PREDICTABLE</small>
                ${[['Rent', 'Every 1st', '$1,450'], ['Phone', 'Every 8th', '$65'], ['Car insurance', 'Every 15th', '$120'], ['Streaming', 'Every 22nd', '$15']].map(([n, d, a], i) => `<div class="tm-kv tut-in" ${at(0.9 + i * 0.35)}><span>${n} <em class="tm-sub">${d}</em></span><b>${a}</b></div>`).join('')}
                <p class="tm-hint tut-in" ${at(2.6)}>Same-ish amount, same-ish day.</p></div>
              <div class="tm-panel tut-in" ${at(1.6)}><small>🛒 EVERYDAY · VARIABLE</small>
                ${[['Groceries', '4 trips', '$86 → $212'], ['Gas', '3 fill-ups', '$38 → $61'], ['Dining out', 'Whenever', '$12 → $94']].map(([n, d, a], i) => `<div class="tm-kv tut-in" ${at(2.1 + i * 0.35)}><span>${n} <em class="tm-sub">${d}</em></span><b>${a}</b></div>`).join('')}
                <p class="tm-hint tut-in" ${at(3.4)}>Different every time. Leave these unticked.</p></div>
            </div>
            <span class="tm-tag tm-tag-gold tut-pop" ${at(4.2, 'left:226px;bottom:14px')}>💵 Regular pay is the income side of fixed</span>` },
        { id: 'mark', title: 'Mark a fixed bill', caption: 'On Transactions, tick Fixed on any recurring bill. MyFinance finds the other months from the same biller and offers to mark them too, so one click covers your whole history.',
          render: () => `${chip(2, 'Mark a fixed bill')}
            <div class="tm-table">${txHead()}
              ${txRow({ date: 'Oct 8', desc: 'VERIZON WIRELESS', cat: 'Phone', tick: check({ onAt: 1.2, id: 'tick' }), amt: '$65.00', cls: 'tm-hl-row', id: 'row' })}
              ${txRow({ date: 'Oct 7', desc: 'TRADER JOE’S #552', cat: 'Groceries', tick: check(), amt: '$86.14' })}
              ${txRow({ date: 'Oct 5', desc: 'SHELL OIL 5741', cat: 'Gas', tick: check(), amt: '$41.30' })}
            </div>
            ${similar('Mark similar payments as fixed?', 'Found <b>5</b> other transactions from <b>VERIZON</b>.', [['Sep 8 · $65.00', 'Not fixed → Fixed bill'], ['Aug 8 · $65.00', 'Not fixed → Fixed bill'], ['Jul 8 · $65.00', 'Not fixed → Fixed bill']], 'Update 5 transactions', 2, 5.2)}
            ${cursor('tick', 0.2)}${cursor('similar-apply', 3.6, 'tick')}
                        ${toast('Marked 6 Verizon payments as Fixed bills', 5.6)}` },
        { id: 'income', title: 'Count your real pay', caption: 'For deposits, the same column means Income. Tick your paychecks so paydays can be forecast. Leave transfers, refunds and paybacks unticked so they never inflate your plan. Review income sorts every sender at once.',
          render: () => `${chip(3, 'Count your real pay')}
            <div class="tm-table">${txHead()}
              ${txRow({ date: 'Oct 16', desc: 'ACME PAYROLL', cat: 'Income', tick: `${check({ onAt: 1, id: 'pay' })}<em class="tm-tick-label">Income</em>`, amt: '$2,100.00', credit: true, delay: 0.3 })}
              ${txRow({ date: 'Oct 12', desc: 'TRANSFER FROM SAVINGS', cat: 'Transfer', tick: `${check()}<em class="tm-tick-label">Not income</em>`, amt: '$500.00', credit: true, delay: 0.6 })}
              ${txRow({ date: 'Oct 9', desc: 'AMAZON REFUND', cat: 'Shopping', tick: `${check()}<em class="tm-tick-label">Not income</em>`, amt: '$42.00', credit: true, delay: 0.9 })}
            </div>
            <div class="tm-callouts tm-callouts-row">
              <p class="tut-in" ${at(2)}><span>✓</span><b>Tick: paychecks</b>Salary, wages, steady side income.</p>
              <p class="tut-in" ${at(2.8)}><span>✗</span><b>Skip: money shuffles</b>Transfers, refunds, a friend paying you back.</p>
              <p class="tut-in" ${at(3.6)}><span>⚡</span><b>Faster: Review income</b>Pick “this is my pay” once per sender.</p>
            </div>${cursor('pay', 0.2)}` },
        { id: 'paymode', title: 'Auto-pay or manual', caption: 'Set how each fixed bill gets paid. Auto-pay leaves on its own. Manual means you have to pay it, so the dashboard flags it and you never miss the ones that need you.',
          render: () => `${chip(4, 'Auto-pay or manual')}
            <div class="tm-split tm-split-tight">
              <div class="tm-panel tut-in" ${at(0.3)}><small>PAYS BY</small>
                <div class="tm-kv"><span>Rent</span><span class="tm-badge tm-badge-manual">Manual</span></div>
                <div class="tm-kv"><span>Phone</span><span class="tm-badge tm-badge-auto">Auto</span></div>
                <div class="tm-kv" data-id="water"><span>City Water</span>${swap('<i class="tm-unset">Not set</i>', '<span class="tm-badge tm-badge-manual">Manual</span>', 1.6)}</div>
                <div class="tm-kv"><span>Streaming</span><span class="tm-badge tm-badge-auto">Auto</span></div>
              </div>
              <div class="tm-panel tm-panel-dark tut-in" ${at(2.2)}><small>ON YOUR DASHBOARD</small>
                <b class="tm-lg">2 bills need you this week</b>
                <div class="tm-kv"><span>Wed 15 · City Water</span><span class="tm-badge tm-badge-manual">Manual</span></div>
                <div class="tm-kv"><span>Fri 1 · Rent</span><span class="tm-badge tm-badge-manual">Manual</span></div>
                <span class="tm-pill tut-pop" ${at(3.4)}>Auto-pay bills run quietly in the background</span>
              </div>
            </div>${cursor('water', 0.4)}` },
        { id: 'calendar', title: 'Watch the forecast appear', caption: 'Fixed bills and paydays now land on the dashboard calendar on the day they usually happen, with a running balance after each one. You can spot a short week before it arrives.',
          render: () => `${chip(5, 'Watch the forecast appear')}
            ${week([['Sun', 12], ['Mon', 13, weekCard('Phone', '$65', { badge: 'Auto', balance: '$1,245', delay: 0.5 })], ['Tue', 14, '', true], ['Wed', 15, weekCard('City Water', '$64', { badge: 'Manual', balance: '$1,181', delay: 1 })], ['Thu', 16, weekCard('Payday', '+$2,100', { tone: 'income', balance: '$3,281', delay: 1.5 })], ['Fri', 17], ['Sat', 18, weekCard('Insurance', '$120', { badge: 'Auto', balance: '$3,161', delay: 2 })]])}
            <div class="tm-note tut-in" ${at(3)}>📉 Lowest point this week: <b>$1,181</b> on Wednesday, the day before payday. No surprises.</div>` },
        { id: 'why', title: 'Fixed or categories?', caption: 'Use Fixed and Income when you care when money moves: it powers the calendar, payday forecast and low-balance warnings. Use Categories when you care what money is for. A bill can be both: rent is fixed and lives in Housing.',
          render: () => `${chip(6, 'Fixed or categories?')}
            ${compare([PAGES.fixed, PAGES.categories])}
            <span class="tm-both tut-pop" ${at(2.6)}>🏠 Rent? <b>Both.</b> Fixed on the 1st, filed under Housing.</span>` },
        { id: 'done', title: 'You are ready', caption: 'That is it. Tick your fixed bills, count your real pay and choose auto or manual. Your forecast does the rest.',
          render: () => outro("You're ready", 'Tick fixed bills · count your pay · auto or manual', 'Mark my fixed bills') }
      ]
    },
    {
      id: 'categories', title: 'Categories & smart rules', blurb: 'See where your money goes, fix a label once and let rules sort future imports.', emoji: '🏷️',
      cta: { label: 'Open my categories', view: 'categories' },
      scenes: [
        { id: 'intro', title: 'Welcome', caption: 'Categories turn a long list of charges into a short story: what your money is for, and where it quietly adds up.',
          render: () => intro('TUTORIAL', 'Categories & smart rules', 'Know what your money is for.', ['🛒', '🍽️', '🏠', '🎬']) },
        { id: 'overview', title: 'Your spending, grouped', caption: 'The Categories page groups every purchase into buckets like Housing, Groceries and Dining, with totals for the period you choose. Search category names to narrow the cards and totals, or reset filters to return to three months. Open any category for its transactions and month-by-month trend.',
          render: () => `${chip(1, 'Your spending, grouped')}
            <div class="tm-cats">
              ${catCard('🏠', 'Housing', '$1,450', 100, 0.3, { note: '1 merchant · fixed' })}
              ${catCard('🛒', 'Groceries', '$612', 42, 0.6, { note: '11 visits' })}
              ${catCard('🍽️', 'Dining', '$388', 27, 0.9, { note: '↑ $96 vs last month', cls: 'is-up', id: 'dining' })}
              ${catCard('⛽', 'Gas', '$164', 11, 1.2, { note: '4 fill-ups' })}
              ${catCard('🎬', 'Subscriptions', '$71', 5, 1.5, { note: '5 services' })}
              ${catCard('❓', 'Uncategorized', '$48', 3, 1.8, { note: '3 to review', cls: 'is-todo' })}
            </div>
            <span class="tm-tag tut-pop" ${at(3.2, 'right:44px;top:56px')}>Dining is creeping up 👀</span>${cursor('dining', 2.4)}` },
        { id: 'fix', title: 'Fix one, fix them all', caption: 'Something in the wrong bucket? Change its category on the Transactions page. MyFinance finds other charges from the same merchant and offers to move them too, with matching amounts preselected.',
          render: () => `${chip(2, 'Fix one, fix them all')}
            <div class="tm-table">${txHead()}
              ${txRow({ date: 'Oct 11', desc: 'BLUE BOTTLE COFFEE', cat: swap('Uncategorized', 'Dining', 1.3), tick: check(), amt: '$6.75', cls: 'tm-hl-row', id: 'cat' })}
              ${txRow({ date: 'Oct 10', desc: 'TRADER JOE’S #552', cat: 'Groceries', tick: check(), amt: '$54.20' })}
            </div>
            ${similar('Update similar transactions?', 'Found <b>6</b> other transactions from <b>BLUE BOTTLE</b>. 4 with about the same amount are preselected.', [['Oct 4 · $6.75', 'Uncategorized → Dining'], ['Sep 27 · $6.75', 'Uncategorized → Dining'], ['Sep 3 · $18.40', 'Uncategorized → Dining · different amount', false]], 'Update 4 transactions', 2.1, 5.6)}
                        ${cursor('cat', 0.3)}${cursor('similar-apply', 4, 'cat')}${toast('Moved 5 Blue Bottle visits to Dining', 6)}` },
        { id: 'rules', title: 'Rules sort future imports', caption: 'Review matching payments before confirming a category change. Leave Remember this category checked to teach future imports, or uncheck it for an existing-payment-only correction. Rename categories or tidy rules any time from Manage categories.',
          render: () => `${chip(3, 'Rules sort future imports')}
            <div class="tm-split tm-split-tight">
              <div class="tm-panel tut-in" ${at(0.3)}><small>YOUR RULES · LEARNED FROM FIXES</small>
                ${[['BLUE BOTTLE', 'Dining'], ['SHELL OIL', 'Gas'], ['TRADER JOE’S', 'Groceries'], ['NETFLIX', 'Subscriptions']].map(([m, c], i) => `<div class="tm-rule tut-in" ${at(0.7 + i * 0.4)}><code>${m}</code><span>→</span><b>${c}</b></div>`).join('')}
              </div>
              <div class="tm-panel tm-panel-dark tut-in" ${at(2.4)}><small>NEXT IMPORT · NOVEMBER.CSV</small>
                <div class="tm-swap-num"><b class="tut-off" ${at(3.4)}>84 new</b><b class="tut-on" ${at(3.4)}>79 sorted</b></div>
                <div class="tm-flow-bar"><span class="is-debt tut-grow" ${at(3.5, '--w:94%')}></span></div>
                <span class="tm-pill tut-pop" ${at(4)}>Only 5 left for you to review</span>
              </div>
            </div>` },
        { id: 'period', title: 'Compare time periods', caption: 'Totals start at Last 3 months. Shared choices include 3, 6, 12 and 24 months, specific periods, custom dates and an explicit All time option. Totals and spending shares use the selected dates. Open a card to review its transactions.',
          render: () => `${chip(4, 'Compare time periods')}
            <div class="tm-row-head"><div><h3>Categories</h3><small>Time period</small></div><span class="tm-toggle"><i class="tut-off" ${at(1.4)}>September</i><i class="tut-on" ${at(1.4)} data-id="oct">October</i></span></div>
            <div class="tm-cats tm-cats-3">
              <div class="tm-cat"><span class="tm-emoji">🍽️</span><b>Dining</b><strong>${swap('$484', '$388', 1.8)}</strong><small class="is-good tut-in" ${at(2.4)}>↓ $96 after cooking Sundays 🎉</small></div>
              <div class="tm-cat"><span class="tm-emoji">🛒</span><b>Groceries</b><strong>${swap('$540', '$612', 1.8)}</strong><small class="tut-in" ${at(2.6)}>↑ $72, expected trade-off</small></div>
              <div class="tm-cat"><span class="tm-emoji">🎬</span><b>Subscriptions</b><strong>${swap('$86', '$71', 1.8)}</strong><small class="is-good tut-in" ${at(2.8)}>↓ $15, one cancelled</small></div>
            </div>${cursor('oct', 0.3)}` },
        { id: 'trends', title: 'Read the six-month trend', caption: 'With Pro Analytics enabled, expand Explore spending insights. Card trend lines use at least six completed months, up to 24, even when your totals cover fewer months. The unfinished current month is excluded. Dots are monthly spending, the dashed line is the average, and change compares the second half with the first. Missing months show a history-needed message, not invented zeros.',
          render: () => `${chip(5, 'Trend and totals have different jobs')}
            <div class="tm-split">
              <div class="tm-panel"><small>SELECTED TOTAL</small><h3>Last 3 months</h3><p>Amount, transaction count and spending share follow your filter.</p><p>Expand Explore spending insights to reveal trends.</p></div>
              <div class="tm-panel"><small>6-MONTH TREND · COMPLETED MONTHS</small><svg viewBox="0 0 300 110" class="tm-chart" aria-hidden="true"><path d="M8 55H292" fill="none" stroke="#64748b" stroke-dasharray="4 4"/><path d="M8 42L65 64L122 35L179 22L236 52L292 62" fill="none" stroke="#397d83" stroke-width="3"/></svg><p>Dashed line: monthly average.</p><p>Second half vs first half, not this partial month.</p></div>
            </div>` },
        { id: 'why', title: 'Categories or transactions?', caption: 'Categories answer where your money goes: patterns and totals. Transactions answer what exactly happened: line by line. Start in Categories to spot a pattern, then jump to Transactions to find the exact charge.',
          render: () => `${chip(5, 'Categories or transactions?')}
            ${compare([PAGES.categories, PAGES.transactions])}
            <span class="tm-both tut-pop" ${at(2.6)}>🔁 Spot it in Categories → find it in Transactions</span>` },
        { id: 'done', title: 'You are ready', caption: 'You are ready. Review anything uncategorized, fix a label once and let your rules do the sorting from now on.',
          render: () => outro("You're ready", 'Review · fix once · let rules sort', 'Open my categories') }
      ]
    },
    {
      id: 'transactions', title: 'Transactions', blurb: 'Import statements, search any charge and edit categories, fixed bills and income in place.', emoji: '🧾',
      cta: { label: 'Open my transactions', view: 'transactions' },
      scenes: [
        { id: 'intro', title: 'Welcome', caption: 'Transactions is your complete history, every charge and deposit, one search away.',
          render: () => intro('TUTORIAL', 'Your transactions', 'Every detail, one search away.', ['📥', '🔍', '🧾', '✅']) },
        { id: 'import', title: 'Bring in a statement', caption: 'Import a supported CSV, OFX or QFX file, or a supported PDF statement. Accounts are matched from the file first, including multi-account CSVs. Identified new accounts are created automatically. Review mappings only for ambiguous or unidentified accounts. If the file does not identify the type, a new CSV account is saved as Other; review its name and type in Accounts. Valid new rows save directly to history after any required mapping review, with a separate entry for each account. Review imported counts, duplicates, warnings and errors in the result. No bank login is needed.',
          render: () => `${chip(1, 'Bring in a statement')}
            <div class="tm-dialog tm-dialog-center tut-pop" ${at(0.3)}>
              <b>Import statements</b><small>Supported CSV, OFX/QFX or PDF &middot; detect accounts, review missing or ambiguous details</small>
              <div class="tm-drop"><span class="tut-off" ${at(1.6)}>Drop a file here</span><span class="tut-on tm-file" ${at(1.6)}>📊 checking-october.csv <small>38 KB</small></span></div>
              <span class="tm-btn tm-btn-primary tut-in" ${at(2.2)} data-id="import">Import</span>
            </div>${cursor('import', 2.4)}${toast('Example result: 84 imported; duplicates reported separately', 3.8)}` },
        { id: 'import-review', title: 'Results, not an approval queue', caption: 'Current imports do not wait in a review queue. Check the result before retrying; duplicate rows are skipped, and rejected files explain the problem. Legacy import review under Transactions is only for older queued records. Add anyway deliberately bypasses duplicate checks, so compare history first. Open Transaction troubleshooting to see which rows count in totals and correct transfer decisions; Activity log records imports and changes. Category suggestions and Review income are separate tools.',
          render: () => `${chip(2, 'Review the result where you import')}
            ${compare([
              { e: '1', title: 'Current imports', when: 'Result in the import dialog', asks: ['Check imported and duplicate counts.', 'Read warnings and errors.', 'Verify the selected account.'] },
              { e: '2', title: 'Legacy review', when: 'Older queued records only', asks: ['Compare with existing history.', 'Add anyway can duplicate a charge.', 'Dismiss only removes the queued copy.'] }
            ])}` },
        { id: 'table', title: 'Read the table', caption: 'Each row shows the date, description, category, a Fixed or Income tick, how it is paid and the amount. Money in is green; money out is red.',
          render: () => `${chip(2, 'Read the table')}
            <div class="tm-table">${txHead()}
              ${txRow({ date: 'Oct 16', desc: 'ACME PAYROLL', cat: 'Income', tick: `${check({ on: true })}<em class="tm-tick-label">Income</em>`, amt: '$2,100.00', credit: true, delay: 0.3 })}
              ${txRow({ date: 'Oct 15', desc: 'CITY WATER', cat: 'Utilities', tick: `${check({ on: true })}<em class="tm-tick-label">Fixed</em>`, pay: 'Manual', amt: '$64.00', delay: 0.6 })}
              ${txRow({ date: 'Oct 14', desc: 'NETFLIX.COM', cat: 'Subscriptions', tick: `${check({ on: true })}<em class="tm-tick-label">Fixed</em>`, pay: 'Auto', amt: '$15.49', delay: 0.9 })}
              ${txRow({ date: 'Oct 11', desc: 'BLUE BOTTLE COFFEE', cat: 'Dining', tick: check(), amt: '$6.75', delay: 1.2 })}
            </div>
            <div class="tm-callouts tm-callouts-row">
              <p class="tut-in" ${at(2)}><span>1</span><b>Category</b>What it was for.</p>
              <p class="tut-in" ${at(2.8)}><span>2</span><b>Fixed / Income</b>Repeats on schedule, or is your pay.</p>
              <p class="tut-in" ${at(3.6)}><span>3</span><b>Pays by</b>Auto-pay or needs you.</p>
            </div>` },
        { id: 'search', title: 'Search and filter', caption: 'Search a merchant, word or amount like 42.50. Transactions starts at Last 3 months; choose 3, 6, 12 or 24 months, a specific period, custom months or All time. Category, payment method and fixed-only filters narrow results. Reset returns to three months. Totals follow the filters.',
          render: () => `${chip(3, 'Search and filter')}
            <div class="tm-filters tut-in" ${at(0.2)}>
              <span class="tm-search" data-id="search">🔍 <span class="tm-type" ${at(0.9)}>netflix</span></span>
              <span class="tm-select">All categories</span><span class="tm-select">Last 6 months</span><span class="tm-select">Pays by: Auto</span>
              <span class="tm-check-label">${check({ onAt: 2.6, id: 'fixedonly' })} Fixed bills only</span>
            </div>
            <div class="tm-metrics tut-in" ${at(1.8)}><div><small>Money out</small><b>${swap('$4,812', '$92.94', 2)}</b></div><div><small>Matching</small><b>${swap('212', '6', 2)}</b></div><div><small>Average</small><b>$15.49</b></div></div>
            <ul class="tm-list">${['Oct 14', 'Sep 14', 'Aug 14'].map((d, i) => `<li class="tut-in" ${at(2.2 + i * 0.25)}><span>${d}</span><b><mark>NETFLIX</mark>.COM</b><i class="tm-badge tm-badge-auto">Auto</i><strong>$15.49</strong></li>`).join('')}</ul>
            ${cursor('search', 0.2)}${cursor('fixedonly', 2.2, 'search')}` },
        { id: 'edit', title: 'Edit right in the row', caption: 'Change a category, tick Fixed or Income, or set Auto-pay or Manual right in the row. Each change can be applied to similar transactions, so your whole history stays consistent.',
          render: () => `${chip(4, 'Edit right in the row')}
            <div class="tm-table">${txHead()}
              ${txRow({ date: 'Oct 15', desc: 'CITY WATER', cat: swap('Uncategorized', 'Utilities', 1), tick: check({ onAt: 2.4, id: 'efix' }), payHtml: `<span data-id="epay">${swap('<i class="tm-unset">—</i>', '<i class="tm-badge tm-badge-manual">Manual</i>', 3.8)}</span>`, amt: '$64.00', cls: 'tm-hl-row', id: 'ecat' })}
              ${txRow({ date: 'Oct 14', desc: 'NETFLIX.COM', cat: 'Subscriptions', tick: check({ on: true }), pay: 'Auto', amt: '$15.49' })}
            </div>
            <div class="tm-steps">
              <span class="tut-in" ${at(1.1)}>① Category <b>Utilities</b></span>
              <span class="tut-in" ${at(2.5)}>② <b>Fixed</b> bill</span>
              <span class="tut-in" ${at(3.9)}>③ Pays by <b>Manual</b></span>
            </div>
            ${cursor('ecat', 0.2)}${cursor('efix', 1.6, 'ecat')}${cursor('epay', 3, 'efix')}
            ${toast('Applied to 5 similar City Water payments', 5)}` },
        { id: 'why', title: 'Which page when?', caption: 'Use Transactions for detail: find a charge, check a refund, fix a row. Use Categories for patterns: where money goes each month. Use Fixed bills and income for timing: when bills and paydays hit your calendar.',
          render: () => `${chip(5, 'Which page when?')}
            ${compare([PAGES.transactions, PAGES.categories, PAGES.fixed], 0.3)}` },
        { id: 'done', title: 'You are ready', caption: 'You are ready. Import a statement, search anything and fix rows in place. Your categories and forecast stay in sync.',
          render: () => outro("You're ready", 'Import · search · edit in place', 'Open my transactions') }
      ]
    },
    {
      id: 'accounts', title: 'Keep Accounts accurate', blurb: 'Confirm ownership, correct account types, refresh stale data and understand what updating an account really changes.', emoji: '🏦',
      cta: { label: 'Review my accounts', view: 'accounts' },
      scenes: [
        { id: 'intro', title: 'Why Accounts matters', caption: 'Accounts tells MyFinance which statements belong together and whether money moved between your own accounts or went to someone else. Reviewing ownership keeps spending, income and savings meaningful. This page organizes imported records; it does not connect to your bank or move money.',
          render: () => intro('ACCOUNTS', 'A trustworthy money picture', 'Identify the account. Confirm ownership. Keep statements current.', ['Ownership', 'Type', 'Freshness']) },
        { id: 'ownership', title: 'Review detected references', caption: 'The Accounts menu badge counts references needing review, not stale accounts. A statement description may mention another account without proving it is yours. If it is yours, choose the correct type and confirm. If it is a friend or other recipient, choose No, it is not mine. You can correct the type later.',
          render: () => `${chip(1, 'Is this one of your accounts?')}
            ${compare([
              { e: '1', title: 'Yes, it is mine', when: 'Confirm its account type', asks: ['Savings? Card? Loan?', 'Use last four digits to distinguish it.', 'Keep your own transfers out of spending.'] },
              { e: '2', title: 'No, it is not mine', when: 'Save an external recipient reference', asks: ['Money sent counts as spending.', 'Money received is other income.', 'No bank connection is created.'] }
            ])}` },
        { id: 'types', title: 'Save the right account type', caption: 'Edit the name, type, bank and last four digits, then Save changes. Checking is everyday cash; savings and investments identify saving transfers. Imported card and loan payments can be recognized as your own transfers. Unknown transfers stay excluded until classified. A wrong type can distort your totals.',
          render: () => `${chip(2, 'Account type changes the meaning')}
            <div class="tm-panel"><small>EXAMPLE ACCOUNT DETAILS</small>
              <div class="tm-kv"><span>Name</span><b>Everyday checking</b></div><div class="tm-kv"><span>Account type</span><b>Checking</b></div><div class="tm-kv"><span>Last four</span><b>1180</b></div><div class="tm-kv"><span>Bank</span><b>Example Bank</b></div>
              <span class="tm-btn tm-btn-primary">Save changes</span><p class="tm-hint">Editing details does not download new transactions.</p></div>` },
        { id: 'freshness', title: 'Understand stale data', caption: 'Last data update means the latest covered transaction or statement date, not the time you edited the account. Data more than 45 calendar days old is marked stale; exactly 45 is not. Last data added shows when transactions were imported. Renaming an account or uploading only older history does not make its coverage current.',
          render: () => `${chip(3, 'Coverage date is not import time')}
            ${compare([
              { e: '1', title: 'Data as of', when: 'How recent is the financial picture?', asks: ['Latest transaction or statement coverage.', 'Older than 45 days: stale.', 'No data: import a recent statement.'] },
              { e: '2', title: 'Last data added', when: 'When were records imported?', asks: ['An import can contain old history.', 'Saving a name does not refresh data.', 'External recipients need no statement.'] }
            ])}` },
        { id: 'refresh', title: 'Update with a statement', caption: 'To update financial data, choose Import a statement. Account details in the file match the same saved accounts automatically when unambiguous, and identified new accounts are created automatically. Review mappings only for ambiguous or unidentified groups. Do not create another account for each month. Review the import result, then check coverage and balances. Assign older imports without an account to the correct saved account. If no valid new rows are added, check whether the file contains newer dates.',
          render: () => `${chip(4, 'Refresh records, not just labels')}
            <div class="tm-panel"><small>AFTER EACH STATEMENT</small><div class="tm-kv"><span>1. Match file accounts</span><b>Review unmatched groups</b></div><div class="tm-kv"><span>2. Import recent activity</span><b>Read the result</b></div><div class="tm-kv"><span>3. Check data coverage</span><b>Confirm latest date</b></div><div class="tm-kv"><span>4. Review detected references</span><b>Mine or external?</b></div></div>` },
        { id: 'statements', title: 'Balances and debt are separate', caption: 'Recorded balances and credit-card statement facts come from imports, not a live bank feed. Supported statements may show the closing date, purchase APR, minimum and due date. Check separately entered debt-plan balances and rates yourself; saving account details does not automatically synchronize the debt-free plan.',
          render: () => `${chip(5, 'Statement facts are not a live connection')}
            ${compare([
              { e: '1', title: 'Accounts', when: 'Imported records and statement facts', asks: ['Check coverage and recorded balance.', 'Review ownership and transfer types.', 'Import again to refresh data.'] },
              { e: '2', title: 'Debt-free plan', when: 'Separately entered planning inputs', asks: ['Review current debt balance.', 'Check APR and minimum payment.', 'Then use payoff projections.'] }
            ])}` },
        { id: 'done', title: 'A useful monthly habit', caption: 'After each import, review new account references, confirm coverage dates and check for stale data. Correct account details when ownership or type is wrong. Import recent statements when the financial picture is old. Neither action moves money.',
          render: () => outro('Keep your picture current', 'Confirm ownership. Import recent records. Review projections.', 'Review my accounts') }
      ]
    },
    {
      id: 'analytics', title: 'Explore Analytics', blurb: 'Pro: navigate the overview, date ranges, mobile charts and Spending Compass without confusing totals with trends.', emoji: '📈',
      cta: { label: 'Open Analytics', view: 'analytics' },
      scenes: [
        { id: 'intro', title: 'Start with the overview', caption: 'Analytics is part of Pro. Start with the overview for cash flow and spending patterns, then choose Spending Compass for household comparisons and possible changes. Both depend on imported records; missing accounts can change the story.',
          render: () => intro('MYFINANCE PRO', 'From totals to patterns', 'Overview for the big picture. Compass for a closer look.', ['Cash flow', 'Spending', 'Compass']) },
        { id: 'ranges', title: 'Know the analysis period', caption: 'Check each panel range before comparing numbers. Shared rolling choices are 3, 6, 12 and 24 months where applicable. Compass starts with three completed months; category-card trends require at least six completed months even when category totals use a shorter range. All time is an explicit choice, not the default.',
          render: () => `${chip(1, 'Match the question to the window')}
            ${compare([
              { e: '1', title: 'Period totals', when: 'Read the selected dates', asks: ['Last 3 months is a common default.', 'All time can make totals much larger.', 'Custom ranges need selected months.'] },
              { e: '2', title: 'Trend analysis', when: 'Use completed history', asks: ['Compass: 3 completed months by default.', 'Category lines: at least 6 completed months.', 'Different windows answer different questions.'] }
            ])}` },
        { id: 'mobile', title: 'Explore on your phone', caption: 'Cards stack on phones. Wide charts and tables scroll inside their panels, not across the entire page. Use swipe hints and sticky row labels to keep context. Expand details when you need the method instead of assuming every visible change is a new spending habit.',
          render: () => `${chip(2, 'Keep context on smaller screens')}
            <div class="tm-panel"><small>MOBILE CHECKLIST</small><div class="tm-kv"><span>Cards</span><b>Stack vertically</b></div><div class="tm-kv"><span>Wide charts and tables</span><b>Swipe inside panel</b></div><div class="tm-kv"><span>Method and readings</span><b>Expand when needed</b></div></div>` },
        { id: 'compass', title: 'Use the Compass thoughtfully', caption: 'Set your household profile, inspect overlapping signals and review the underlying spending before acting. Suggested savings and five-year illustrations are possibilities, not promises. The separate Spending Compass tutorial explains money flow, normal ranges, one-offs and seasonal comparisons.',
          render: () => outro('Choose one realistic experiment', 'Review the evidence before changing a habit.', 'Explore the Spending Compass tutorial') },
        { id: 'done', title: 'You are ready', caption: 'Choose a period, read the overview and investigate one pattern at a time. Keep records current through Accounts and imports. Analytics explains the past; it cannot guarantee future income or savings.',
          render: () => outro('Turn evidence into a next step', 'Check dates. Review context. Make one change.', 'Open Analytics') }
      ]
    },
    {
      id: 'compass', title: 'Spending Compass', blurb: 'Pro: see where your money flows, which habits stand out against similar households and your own history, and what to change.', emoji: '🧭',
      cta: { label: 'Open my Spending Compass', view: 'analytics/compass' },
      scenes: [
        { id: 'intro', title: 'Welcome', caption: 'The Spending Compass shows where your money goes, which habits stand out against households like yours and against your own history, and where you could realistically save.',
          render: () => intro('TUTORIAL · UNDER 2 MINUTES', 'Spending Compass', 'Where your money goes. What stands out. What to change.', ['🧭', '🍽️', '⚡', '💰']) },
        { id: 'open', title: 'Find the Compass', caption: 'Open Analytics and choose the Spending Compass tab. It starts with three completed months. The top summarizes potential changes, such as $170 a month or about $10,000 over five years, and lists current and suggested category levels. These are illustrations, not guaranteed savings. Spending Compass is part of Pro.',
          render: () => `${chip(1, 'Find the Compass')}
            <div class="tm-row-head"><div><h3>${swap('Your spending, like a market', 'Spending Compass', 1.4)}</h3><small>Analytics</small></div></div>
            <div class="tm-tabs"><i class="tm-tab-drop" ${at(1.3)}>Overview</i><i class="tm-tab-pick" ${at(1.3)} data-id="tab">Spending Compass <em class="tut-pop" ${at(0.6)}>$170/mo</em></i></div>
            <div class="tm-hero tut-in" ${at(1.9)}>
              <div><small>YOUR COMPASS FOUND</small><b>$170 a month</b><span>$2,043 a year · $10,216 over 5 years</span></div>
              <ol>
                <li class="tut-in" ${at(3.2)}><span><b>Dining</b><small>$452 → $323 a month</small></span><strong>$129</strong></li>
                <li class="tut-in" ${at(3.8)}><span><b>Utilities</b><small>$440 → $399 a month</small></span><strong>$41</strong></li>
              </ol>
            </div>${cursor('tab', 0.4)}` },
        { id: 'household', title: 'Set your household', caption: 'Tell the Compass how many people live with you, your region and whether you rent or own. Typical spending comes from the government Consumer Expenditure Survey for households like yours. No other MyFinance user\'s data is ever used.',
          render: () => `${chip(2, 'Set your household')}
            <div class="tm-split tm-split-tight">
              <div class="tm-panel tut-in" ${at(0.3)}><small>YOUR COMPARISON</small>
                ${[['People in your household', '2'], ['Region', 'Northeast'], ['Home', 'Own']].map(([k, v], i) => `<div class="tm-kv tut-in" ${at(0.8 + i * 0.4)}><span>${k}</span><b>${v}</b></div>`).join('')}
                <span class="tm-btn tm-btn-primary tut-in" ${at(2)} data-id="save">Save household</span>
                <p class="tm-hint tut-in" ${at(2.4)}>Until you set it, you are compared with the average U.S. household.</p>
              </div>
              <div class="tm-panel tm-panel-dark tut-in" ${at(1.2)}><small>TYPICAL SPENDING FROM</small>
                <b class="tm-lg">U.S. Bureau of Labor Statistics</b><span class="tm-pill">Consumer Expenditure Survey · 2024</span>
                <div class="tm-kv tut-in" ${at(3.6)}><span>Adjusted for household size, region, rent or own</span></div>
                <div class="tm-kv tut-in" ${at(4.2)}><span>🔒 No other MyFinance user's data is used</span></div>
              </div>
            </div>${cursor('save', 2.6)}${toast('Household saved. Your comparison is updated.', 3.6)}` },
        { id: 'flow', title: 'Where your money flows', caption: 'Where your money flows follows each dollar of income into fixed bills, everyday spending and what is left over. A red ribbon is a category worth acting on. Beside it, the cards show what stood out, such as $1,435 a year on purchases under $20.',
          render: () => {
            const rib = (x0, a0, a1, x1, b0, b1, cls, delay) => { const m = (x0 + x1) / 2; return `<path class="tm-rib ${cls} tut-in" ${at(delay)} d="M${x0} ${a0}C${m} ${a0} ${m} ${b0} ${x1} ${b0}L${x1} ${b1}C${m} ${b1} ${m} ${a1} ${x0} ${a1}Z"/>`; };
            return `${chip(3, 'Where your money flows')}
            <div class="tm-split tm-split-tight tm-split-wide">
              <div class="tm-panel tut-in" ${at(0.3)}><small>INCOME $8,405 A MONTH</small>
                <svg class="tm-sankey" viewBox="0 0 360 172" aria-hidden="true">
                  <rect x="0" y="0" width="8" height="158" rx="2" class="tm-node-in"/>
                  ${rib(8, 0, 81, 110, 0, 81, 'is-fixed', 0.8)}${rib(8, 81, 123, 110, 87, 129, 'is-day', 1.2)}${rib(8, 123, 158, 110, 135, 170, 'is-left', 1.6)}
                  <rect x="110" y="0" width="8" height="81" rx="2" class="tm-node-fixed"/><rect x="110" y="87" width="8" height="42" rx="2" class="tm-node-day"/><rect x="110" y="135" width="8" height="35" rx="2" class="tm-node-left"/>
                  ${rib(118, 87, 99, 215, 88, 100, 'is-day', 2.2)}${rib(118, 99, 107, 215, 105, 113, 'is-act', 2.6)}${rib(118, 107, 129, 215, 118, 140, 'is-day', 2.4)}
                  <rect x="215" y="88" width="8" height="12" rx="2" class="tm-node-day"/><rect x="215" y="105" width="8" height="8" rx="2" class="tm-node-act"/><rect x="215" y="118" width="8" height="22" rx="2" class="tm-node-day"/>
                  <text x="124" y="16">Fixed bills $4,294</text><text x="124" y="104" class="tm-halo">Everyday $2,252</text><text x="124" y="156" class="tm-good">Left over $1,858</text>
                  <text x="229" y="97">Groceries</text><text x="229" y="113" class="tm-bad">Dining $452</text><text x="229" y="133">Everything else</text>
                </svg>
              </div>
              <div class="tm-insights">
                <div class="tm-insight is-warn tut-in" ${at(3.4)} data-id="small"><b>$1,435 a year</b><span>on purchases under $20</span><small>STARBUCKS, 9 times a month</small></div>
                <div class="tm-insight is-bad tut-in" ${at(4.6)}><b>+$107 a month</b><span>Dining: more often, and pricier</span><small>19 visits at $24, was 17 at $21</small></div>
                <div class="tm-insight tut-in" ${at(5.8)}><b>1.2 days</b><span>of work a month go to Dining</span></div>
              </div>
            </div>${cursor('small', 3.8)}`;
          } },
        { id: 'signals', title: 'Read the signals', caption: 'Where the signals overlap sorts each category into three circles: above similar homes, trending up, and an unusual last month. Where circles overlap, act. Your normal range shows the band that 9 in 10 of your months fall in, and where last month landed. The crossover, momentum, breakout and breadth readings sit under Technical readings.',
          render: () => `${chip(4, 'Read the signals')}
            <div class="tm-split tm-split-tight tm-split-wide">
              <div class="tm-panel tut-in" ${at(0.3)}><small>WHERE THE SIGNALS OVERLAP</small>
                <svg class="tm-venn" viewBox="0 0 240 200" aria-hidden="true">
                  <circle cx="92" cy="78" r="60" class="is-a tut-pop" ${at(0.8)}/><circle cx="148" cy="78" r="60" class="is-b tut-pop" ${at(1.4)}/><circle cx="120" cy="128" r="60" class="is-c tut-pop" ${at(2)}/>
                  <text x="14" y="12">Above similar homes</text><text x="232" y="12" text-anchor="end">Trending up</text><text x="120" y="198" text-anchor="middle">Unusual month</text>
                  <text x="120" y="60" text-anchor="middle" class="tm-bad tut-in" ${at(3)}>Dining</text><text x="178" y="74" text-anchor="middle" class="tut-in" ${at(3.6)}>Utilities</text><text x="62" y="74" text-anchor="middle" class="tut-in" ${at(3.9)}>Gas</text>
                </svg>
                <span class="tm-pill tm-pill-act tut-pop" ${at(4.4)}>Two signals agree: act on Dining</span>
              </div>
              <div class="tm-panel tut-in" ${at(6)}><small>YOUR NORMAL RANGE · 5TH–95TH PERCENTILE</small>
                <div class="tm-range"><span>Dining</span><div><i class="tm-range-band" style="left:35%;width:58%"></i><i class="tm-range-typ" style="left:80%"></i><i class="tm-range-dot is-warn tut-pop" ${at(8, 'left:85%')}></i></div><b class="tm-warn">Higher than 10 of 11</b></div>
                <div class="tm-range"><span>Groceries</span><div><i class="tm-range-band" style="left:56%;width:37%"></i><i class="tm-range-typ" style="left:66%"></i><i class="tm-range-dot is-good tut-pop" ${at(9, 'left:53%')}></i></div><b class="tm-good">Lowest in a year</b></div>
                <p class="tm-hint tut-in" ${at(10)}>Shaded: your usual range. Dot: last month. Diamond: similar households.</p>
              </div>
            </div>` },
        { id: 'fair', title: 'One-offs and seasons', caption: 'Behavioural signals set aside a big one-off, at least $250 and five times your usual charge, so it does not look like a habit. Raw money-flow, merchant and heatmap totals still include every non-transfer payment, including large and fixed payments. Select a merchant bubble to inspect exact payments and separate credits. Compass uses completed months; match those exact dates in Transactions. Seasonal bills like energy are compared with the same months last year.',
          render: () => `${chip(5, 'One-offs and seasons')}
            <div class="tm-split tm-split-tight">
              <div class="tm-panel tut-in" ${at(0.3)}><small>ONE-OFF PURCHASES</small>
                <div class="tm-kv"><span>SAFEWAY · Groceries</span><b>$86.40</b></div>
                <div class="tm-kv tm-hl" ${at(1.4)}><span>BEST BUY · Shopping</span><b>$1,249.99</b></div>
                <span class="tm-sig is-ok tut-pop" ${at(2.2)}>Set aside · not a habit</span>
                <p class="tm-hint tut-in" ${at(2.8)}>At least $250 and 5× your usual charge in that category.</p>
              </div>
              <div class="tm-panel tut-in" ${at(3.6)}><small>SEASONAL BILLS · ENERGY</small>
                <div class="tm-vs"><span>This winter</span><div class="tm-bar"><span class="tut-grow" ${at(4.4, '--w:100%')}></span></div><b>$440</b></div>
                <div class="tm-vs"><span>Last winter</span><div class="tm-bar tm-bar-typ"><span class="tut-grow" ${at(4.8, '--w:91%')}></span></div><b>$399</b></div>
                <p class="tm-hint tut-in" ${at(5.6)}>Compared with the same months last year, not with summer.</p>
              </div>
            </div>` },
        { id: 'done', title: 'You are ready', caption: 'You are ready. Set your household once, check the Compass after each import and pick one category to bring back to a level you have already reached.',
          render: () => outro("You're ready", 'Follow the flow · read the signals · save', 'Open my Spending Compass') }
      ]
    }
  ];
  const ALIASES = { 'debt-strategies': ['debt', 'strategy'], 'debt-dates': ['debt', 'dates'], payoff: ['debt', null], plan: ['debt', null], 'fixed-bills': ['fixed', null], income: ['fixed', 'income'], categorization: ['categories', null], 'which-page': ['transactions', 'why'], 'spending-compass': ['compass', null], 'compass-signals': ['compass', 'signals'] };

  const sceneDuration = scene => scene.duration || Math.max(6500, scene.caption.split(/\s+/).length * 330 + 1800);

  const state = { tutorial: TUTORIALS[0], index: 0, elapsed: 0, playing: false, last: 0, raf: 0, voice: storage.get('mf.tutorials.voice') === '1', speaking: false, ended: false, built: false, observer: null };

  function totalTime(tutorial) { return tutorial.scenes.reduce((sum, scene) => sum + sceneDuration(scene), 0); }
  const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  function build() {
    const root = $('tutorial-root');
    if (!root) return false;
    if (state.built && root.querySelector('.tut-player')) return true;
    root.innerHTML = `
      <div class="tut-layout">
        <div class="tut-player" id="tut-player" tabindex="-1" role="region" aria-label="Tutorial player">
          <div class="tut-stage" id="tut-stage">
            <div class="tut-canvas" id="tut-canvas"></div>
            <button type="button" class="tut-bigplay" id="tut-bigplay" aria-label="Play tutorial">${icon('play', 30)}</button>
            <div class="tut-end" id="tut-end" hidden></div>
          </div>
          <div class="tut-controls">
            <button type="button" class="tut-ctl tut-ctl-main" data-tut="toggle" id="tut-toggle" aria-label="Play">${icon('play', 18)}</button>
            <button type="button" class="tut-ctl" data-tut="prev" aria-label="Previous chapter">${icon('prev', 16)}</button>
            <button type="button" class="tut-ctl" data-tut="next" aria-label="Next chapter">${icon('next', 16)}</button>
            <div class="tut-segments" id="tut-segments" role="group" aria-label="Chapters"></div>
            <span class="tut-time" id="tut-time">0:00</span>
            <button type="button" class="tut-ctl" data-tut="voice" id="tut-voice" aria-pressed="false" aria-label="Voice narration"></button>
            <button type="button" class="tut-ctl" data-tut="full" aria-label="Full screen">${icon('full', 16)}</button>
          </div>
          <p class="tut-caption" id="tut-caption" aria-live="polite"></p>
        </div>
        <aside class="tut-side">
          <div class="tut-side-head"><p class="eyebrow" id="tut-side-eyebrow"></p><h2 id="tut-side-title"></h2></div>
          <ol class="tut-chapters" id="tut-chapters"></ol>
          <a class="btn btn-primary tut-cta" id="tut-cta" href="#dashboard"></a>
        </aside>
      </div>
      <section class="tut-library" aria-label="All tutorials">
        <h2>All tutorials</h2>
        <div class="tut-cards">${TUTORIALS.map(tutorial => `<a class="tut-card" href="#tutorials/${tutorial.id}" data-tut-card="${tutorial.id}">
          <span class="tut-thumb"><i>${tutorial.emoji}</i><b>${icon('play', 18)}</b></span>
          <span class="tut-card-body"><strong>${esc(tutorial.title)}</strong><span>${esc(tutorial.blurb)}</span><small>${icon('clock', 13)} ${clock(totalTime(tutorial))} · ${tutorial.scenes.length} chapters</small></span></a>`).join('')}</div>
      </section>`;
    state.built = true;
    const stage = $('tut-stage');
    const fit = () => {
      const width = stage.clientWidth || W;
      stage.style.setProperty('--tut-scale', String(width / W));
    };
    if (typeof ResizeObserver === 'function') { state.observer?.disconnect(); state.observer = new ResizeObserver(fit); state.observer.observe(stage); }
    window.addEventListener('resize', fit);
    fit();
    return true;
  }

  function renderShell() {
    const t = state.tutorial;
    $('tut-side-eyebrow').textContent = `TUTORIAL · ${clock(totalTime(t))}`;
    $('tut-side-title').textContent = t.title;
    $('tut-chapters').innerHTML = t.scenes.map((scene, index) => `<li><button type="button" data-tut-go="${index}"><span class="tut-num">${icon('check', 12)}<b>${index + 1}</b></span><span>${esc(scene.title)}</span><small>${clock(sceneDuration(scene))}</small></button></li>`).join('');
    $('tut-segments').innerHTML = t.scenes.map((scene, index) => `<button type="button" class="tut-seg" data-tut-go="${index}" style="flex:${sceneDuration(scene)}" aria-label="Chapter ${index + 1}: ${esc(scene.title)}"><span></span></button>`).join('');
    const cta = $('tut-cta');
    cta.textContent = t.cta.label;
    cta.href = `#${t.cta.view}`;
    document.querySelectorAll('.tut-card').forEach(card => card.classList.toggle('is-current', card.dataset.tutCard === t.id));
  }

  function renderScene() {
    const t = state.tutorial, scene = t.scenes[state.index];
    const canvas = $('tut-canvas');
    canvas.className = `tut-canvas scene-${scene.id}`;
    canvas.innerHTML = scene.render();
    canvas.setAttribute('aria-label', `${scene.title}. ${scene.caption}`);
    canvas.setAttribute('role', 'img');
    $('tut-caption').textContent = scene.caption;
    $('tut-end').hidden = true;
    state.ended = false;
    state.elapsed = 0;
    placeCursors(canvas);
    document.querySelectorAll('#tut-chapters button').forEach((button, index) => {
      button.classList.toggle('is-active', index === state.index);
      button.classList.toggle('is-done', index < state.index);
      if (index === state.index) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    });
    syncStage();
    updateProgress();
    if (state.playing) speak(scene.caption);
  }

  // Cursor targets are resolved after layout so the pointer lands on the real mock element.
  function placeCursors(canvas) {
    const scale = canvas.getBoundingClientRect().width / W || 1;
    const box = canvas.getBoundingClientRect();
    const center = id => {
      const node = canvas.querySelector(`[data-id="${id}"]`);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: (rect.left - box.left + rect.width / 2) / scale, y: (rect.top - box.top + rect.height / 2) / scale };
    };
    canvas.querySelectorAll('.tut-cursor').forEach(node => {
      const to = center(node.dataset.to) || { x: W / 2, y: H / 2 };
      const from = node.dataset.from ? center(node.dataset.from) || { x: to.x + 140, y: to.y + 90 } : { x: Math.min(W - 30, to.x + 160), y: Math.min(H - 20, to.y + 110) };
      node.style.setProperty('--x0', `${from.x}px`); node.style.setProperty('--y0', `${from.y}px`);
      node.style.setProperty('--x1', `${to.x}px`); node.style.setProperty('--y1', `${to.y}px`);
    });
  }

  function syncStage() {
    const stage = $('tut-stage');
    if (!stage) return;
    stage.classList.toggle('is-paused', !state.playing);
    stage.classList.toggle('is-reduced', reducedMotion());
    $('tut-bigplay').hidden = state.playing || state.ended;
    const toggle = $('tut-toggle');
    toggle.innerHTML = icon(state.playing ? 'pause' : 'play', 18);
    toggle.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    const voice = $('tut-voice');
    voice.innerHTML = icon(state.voice ? 'voice' : 'mute', 16);
    voice.setAttribute('aria-pressed', String(state.voice));
    voice.title = state.voice ? 'Narration on' : 'Narration off';
    voice.hidden = !('speechSynthesis' in window);
  }

  function updateProgress() {
    const t = state.tutorial;
    const durations = t.scenes.map(sceneDuration);
    const fraction = Math.min(1, state.elapsed / durations[state.index]);
    document.querySelectorAll('#tut-segments .tut-seg').forEach((segment, index) => {
      segment.querySelector('span').style.width = `${index < state.index ? 100 : index === state.index ? fraction * 100 : 0}%`;
      segment.classList.toggle('is-active', index === state.index);
    });
    const before = durations.slice(0, state.index).reduce((sum, value) => sum + value, 0);
    $('tut-time').textContent = `${clock(before + state.elapsed)} / ${clock(totalTime(t))}`;
  }

  function speak(text) {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    state.speaking = false;
    if (!state.voice || !text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    utterance.onend = utterance.onerror = () => { state.speaking = false; };
    state.speaking = true;
    synth.speak(utterance);
  }

  function frame(now) {
    if (!state.playing) return;
    if (!$('tutorials-view')?.classList.contains('active')) return pause();
    state.elapsed += Math.min(250, now - state.last);
    state.last = now;
    const duration = sceneDuration(state.tutorial.scenes[state.index]);
    if (state.elapsed >= duration && !state.speaking) {
      if (state.index < state.tutorial.scenes.length - 1) { state.index += 1; renderScene(); }
      else return finish();
    } else if (state.elapsed > duration) state.elapsed = duration;
    updateProgress();
    state.raf = requestAnimationFrame(frame);
  }

  function play() {
    if (state.ended) { state.index = 0; renderScene(); }
    state.playing = true;
    state.last = performance.now();
    syncStage();
    const synth = window.speechSynthesis;
    if (state.voice && synth) {
      if (synth.paused) synth.resume();
      else if (!synth.speaking && state.elapsed < 400) speak(state.tutorial.scenes[state.index].caption);
    }
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(frame);
    window.FinanceWelcome?.markTourSeen?.();
  }
  function pause() {
    state.playing = false;
    cancelAnimationFrame(state.raf);
    if (window.speechSynthesis?.speaking) window.speechSynthesis.pause();
    syncStage();
  }
  function go(index) {
    const count = state.tutorial.scenes.length;
    state.index = Math.max(0, Math.min(count - 1, index));
    window.speechSynthesis?.cancel();
    state.speaking = false;
    renderScene();
    if (state.playing) { state.last = performance.now(); }
  }
  function finish() {
    state.playing = false;
    state.ended = true;
    cancelAnimationFrame(state.raf);
    state.elapsed = sceneDuration(state.tutorial.scenes[state.index]);
    updateProgress();
    const t = state.tutorial;
    const next = TUTORIALS[(TUTORIALS.indexOf(t) + 1) % TUTORIALS.length];
    const end = $('tut-end');
    end.innerHTML = `<div class="tut-end-card"><p>TUTORIAL COMPLETE</p><h3>${esc(t.title)}</h3>
      <div class="tut-end-actions"><a class="btn btn-primary" href="#${t.cta.view}">${esc(t.cta.label)}</a><button type="button" class="btn btn-secondary" data-tut="replay">${icon('replay', 15)} Replay</button></div>
      <a class="tut-end-next" href="#tutorials/${next.id}">Up next: ${esc(next.title)} ${icon('arrow', 14)}</a></div>`;
    end.hidden = false;
    document.querySelectorAll('#tut-chapters button').forEach(button => button.classList.add('is-done'));
    syncStage();
  }

  function open(sub = '') {
    if (!build()) return;
    const [rawId, rawScene] = String(sub || '').split('/');
    const alias = ALIASES[rawId];
    const id = alias ? alias[0] : rawId;
    const tutorial = TUTORIALS.find(item => item.id === id) || (rawId ? null : state.tutorial) || TUTORIALS[0];
    const sceneId = alias ? alias[1] : rawScene;
    const changed = tutorial !== state.tutorial || !$('tut-chapters').children.length;
    pause();
    state.tutorial = tutorial;
    renderShell();
    const sceneIndex = sceneId ? tutorial.scenes.findIndex(scene => scene.id === sceneId) : -1;
    state.index = sceneIndex >= 0 ? sceneIndex : changed || state.ended ? 0 : state.index;
    renderScene();
    window.FinanceWelcome?.markTourSeen?.();
    // Deep links start playing straight away; reduced-motion users press play themselves.
    if (sub && !reducedMotion()) play();
    $('tut-player')?.focus({ preventScroll: true });
  }

  document.addEventListener('click', event => {
    const root = $('tutorial-root');
    if (!root || !root.contains(event.target)) return;
    const target = event.target.closest('[data-tut],[data-tut-go],#tut-bigplay');
    if (!target) return;
    if (target.id === 'tut-bigplay') return play();
    if (target.dataset.tutGo != null) return go(Number(target.dataset.tutGo));
    switch (target.dataset.tut) {
      case 'toggle': return state.playing ? pause() : play();
      case 'prev': return go(state.elapsed > 1500 ? state.index : state.index - 1);
      case 'next': return state.index >= state.tutorial.scenes.length - 1 ? finish() : go(state.index + 1);
      case 'replay': state.index = 0; renderScene(); return play();
      case 'voice':
        state.voice = !state.voice;
        storage.set('mf.tutorials.voice', state.voice ? '1' : '0');
        if (!state.voice) { window.speechSynthesis?.cancel(); state.speaking = false; }
        else if (state.playing) speak(state.tutorial.scenes[state.index].caption);
        return syncStage();
      case 'full': {
        const player = $('tut-player');
        if (document.fullscreenElement) return document.exitFullscreen?.();
        return player?.requestFullscreen?.().catch(() => {});
      }
    }
  });
  document.addEventListener('keydown', event => {
    const player = $('tut-player');
    if (!player || !player.contains(document.activeElement) || event.altKey || event.ctrlKey || event.metaKey) return;
    const onButton = document.activeElement?.tagName === 'BUTTON' || document.activeElement?.tagName === 'A';
    if ((event.key === ' ' && !onButton) || event.key === 'k' || event.key === 'K') { event.preventDefault(); state.playing ? pause() : play(); }
    else if (event.key === 'ArrowRight' || event.key === 'l') { event.preventDefault(); go(state.index + 1); }
    else if (event.key === 'ArrowLeft' || event.key === 'j') { event.preventDefault(); go(state.index - 1); }
    else if (event.key === 'f') { event.preventDefault(); document.fullscreenElement ? document.exitFullscreen?.() : player.requestFullscreen?.().catch(() => {}); }
  });
  // Leaving the view stops playback and narration.
  window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#tutorials')) pause(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.playing) pause(); });

  window.FinanceTutorials = { open, play, pause, go, list: () => TUTORIALS.map(({ id, title, scenes }) => ({ id, title, chapters: scenes.map(scene => scene.id) })), state };
})();
