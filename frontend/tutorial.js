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

  // ---------- tutorials ----------
  const TUTORIALS = [
    {
      id: 'debt', title: 'Your debt-free plan', blurb: 'Add debts, pick a strategy, understand the dates and flex a tight month.', emoji: '🏁',
      cta: { label: 'Open my debt-free plan', view: 'payoff' },
      scenes: [
        { id: 'intro', title: 'Welcome', caption: 'Your debt-free plan gathers every card and loan in one place and shows the fastest, cheapest path to zero.',
          render: () => intro('TUTORIAL · ABOUT 1 MINUTE', 'Your debt-free plan', 'Every balance. One plan. A real finish line.', ['💳', '🚗', '🎓', '🏁']) },
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
        { id: 'strategy', title: 'Choose a strategy', caption: 'Pick a strategy. Avalanche pays the highest rate first and costs the least. Snowball clears the smallest balance first for quick wins. Every strategy still pays all minimums.',
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
        { id: 'budget', title: 'Set your budget', caption: 'Set what you can put toward debt each month. Anything above the minimums is your extra, and the finish line moves the moment you change it.',
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
        { id: 'guidance', title: 'Follow the guidance', caption: 'Guidance reads your rates and cash flow. It flags the debt costing you most, tells you when a focus costs extra, and shows how much sooner a little more would get you there.',
          render: () => `${chip(6, 'Follow the guidance')}
            <div class="tm-row-head"><div><h3>Guidance</h3><small>Based on your rates, balances and recent cash flow</small></div></div>
            <ul class="tm-guide">
              <li class="is-warn tut-in" ${at(0.6)}><i>!</i><div><b>Visa Signature is your most expensive money</b><span>At 24.9% APR it costs about $129 a month in interest.</span></div></li>
              <li class="is-good tut-in" ${at(1.8)}><i>✓</i><div><b>Adding $100 a month makes you debt-free 4 months sooner</b><span>About half of your typical monthly surplus.</span></div></li>
              <li class="is-info tut-in" ${at(3)}><i>i</i><div><b>Your focus on Store card costs about $18</b><span>A fair trade if clearing it matters to you.</span></div></li>
              <li class="is-info tut-in" ${at(4.2)}><i>i</i><div><b>Keep a starter emergency fund</b><span>Hold about $1,000 so a surprise doesn't land back on a card.</span></div></li>
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
        { id: 'pro', title: 'What-if and your own order', caption: 'With MyFinance Pro you can test a raise, a bonus or a lump sum before you commit, and set your own payoff order. That is everything. Open your plan and take the first step.',
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
        { id: 'intro', title: 'Welcome', caption: 'Savings goals give every dollar of surplus a job, next to your bills and your debt-free plan.',
          render: () => intro('TUTORIAL · ABOUT 1 MINUTE', 'Savings goals', 'Make room for what matters.', ['🛡️', '✈️', '💻', '🎯']) },
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
        { id: 'surplus', title: 'Where your surplus goes', caption: 'MyFinance works out your typical monthly surplus from recent months. It funds your debt extra first, then your goals, and shows what is still free.',
          render: () => `${chip(2, 'Where your surplus goes')}
            <div class="tm-panel tm-flow">
              <small>TYPICAL MONTHLY SURPLUS</small><strong>$1,050<em>/mo</em></strong>
              <div class="tm-flow-bar"><span class="is-debt tut-grow" ${at(1, '--w:20%')}></span><span class="is-goal tut-grow" ${at(2, '--w:57%')}></span><span class="is-free tut-grow" ${at(3, '--w:23%')}></span></div>
              <div class="tm-legend"><span class="is-debt tut-in" ${at(1.2)}><i></i>Debt extra <b>$210</b></span><span class="is-goal tut-in" ${at(2.2)}><i></i>Goals <b>$600</b></span><span class="is-free tut-in" ${at(3.2)}><i></i>Still free <b>$240</b></span></div>
            </div>` },
        { id: 'strategy', title: 'Choose how goals are funded', caption: 'Choose how the goal budget is shared. Priority order funds your most important goal first. Nearest deadline protects the soonest date. Balanced, a Pro option, moves everything together.',
          render: () => `${chip(3, 'Choose how goals are funded')}
            <div class="tm-strats tm-strats-3">
              ${strat('Priority order', 'Most important first', 'Emergency', 'funded first', 'Emergency fund', { active: true, reco: false, id: 'prio', ringOut: 2, unit: '' })}
              ${strat('Nearest deadline', 'Soonest date first', 'Vacation', 'funded first', 'Vacation', { id: 'dead', ringIn: 2, unit: '' })}
              ${strat('Balanced', 'Everything moves together', '', '', '', { pro: true })}
            </div>${toast('Switched to Nearest deadline. Goal amounts are updated.', 2.5)}${cursor('dead', 0.6)}` },
        { id: 'status', title: 'Stay on track', caption: 'Each goal shows its monthly amount and status. If one falls behind, you will see exactly how much more it needs each month, here and on your dashboard.',
          render: () => `${chip(4, 'Stay on track')}
            <div class="tm-goals">
              <div class="tm-goal tut-in" ${at(0.4)}><span class="tm-emoji">🛡️</span><b>Emergency fund</b><small>$1,200 of $5,000 · $280/mo</small><div class="tm-bar"><span class="tut-grow" ${at(0.8, '--w:24%')}></span></div><em class="is-good">On track</em></div>
              <div class="tm-goal tut-in" ${at(1)}><span class="tm-emoji">✈️</span><b>Vacation</b><small>$900 of $3,000 · $150/mo</small><div class="tm-bar"><span class="tut-grow" ${at(1.4, '--w:30%')}></span></div><em class="is-warn">Behind</em><p class="tut-in" ${at(2.6)}>Needs $60 more a month to make June.</p></div>
              <div class="tm-goal tut-in" ${at(1.6)}><span class="tm-emoji">💻</span><b>New laptop</b><small>$1,400 of $1,400</small><div class="tm-bar"><span class="tut-grow" ${at(2, '--w:100%')}></span></div><em class="is-good">Funded</em></div>
            </div>` },
        { id: 'flex', title: 'Flex and record savings', caption: 'Goal contributions appear on the calendar too, so you can trim one in a tight month. When you move money into savings, record it and the progress bar catches up.',
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
          render: () => intro('TUTORIAL · ABOUT 1 MINUTE', 'Your dashboard', 'Know where you stand. Choose what comes next.', ['👋', '📅', '💵', '✅']) },
        { id: 'insights', title: 'Rotating insights', caption: 'Insights rotate through anything that needs you: a day you might run short, bills due soon, payday, goals and your debt-free date. Hover to pause, or use the arrows.',
          render: () => `${chip(1, 'Rotating insights')}
            <div class="tm-hero">
              <small>WEDNESDAY, OCTOBER 14</small><h3>Good evening, Alex 👋</h3><p>One thing needs your attention today.</p>
              <div class="tm-hero-card">
                <div class="tut-off" ${at(3.2)}><em class="is-bad">NEEDS ATTENTION</em><b>You could run short Tuesday</b><span>After Rent on the 20th, your balance drops to −$180.</span></div>
                <div class="tut-on" ${at(3.2)}><em class="is-good">NICE WORK</em><b>Payday in 2 days</b><span>Expect about $2,100 from ACME on Friday (every other week).</span></div>
                <div class="tm-dots"><i class="tm-dot-fill" ${at(0)}></i><i class="tm-dot-fill" ${at(3.2)}></i><i></i><i></i></div>
              </div>
            </div>` },
        { id: 'glance', title: 'Today at a glance', caption: 'Today at a glance keeps the essentials in view: your balance, next payday, what is left to pay this month and your lowest point ahead.',
          render: () => `${chip(2, 'Today at a glance')}
            <div class="tm-pulse">
              ${[['Balance', '$2,310.42', 'Latest recorded'], ['Next payday', '$2,100', 'In 2 days · the 16th'], ['Bills left this month', '$2,264', '6 payments to go'], ['Lowest point ahead', '$412', 'On the 20th'], ['Debt-free', 'Mar 2028', 'On your current plan']]
                .map(([label, value, note], index) => `<div class="tut-in" ${at(0.5 + index * 0.7)}><span>${label}</span><b>${value}</b><small>${note}</small></div>`).join('')}
            </div>` },
        { id: 'week', title: 'The week ahead', caption: 'Upcoming payments are laid out week by week. Grey cards are already paid; bright cards are still coming. Each card shows the projected balance after it clears.',
          render: () => `${chip(3, 'The week ahead')}
            ${week([['Sun', 12], ['Mon', 13, weekCard('Rent', '$1,450', { paid: true, balance: '$2,310', delay: 0.4 })], ['Tue', 14, weekCard('Netflix', '$15', { badge: 'Auto', balance: '$2,295', delay: 0.9 }), true], ['Wed', 15, weekCard('City Water', '$64', { badge: 'Manual', balance: '$2,231', delay: 1.4 })], ['Thu', 16, weekCard('Payday', '+$2,100', { tone: 'income', balance: '$4,331', delay: 1.9 })], ['Fri', 17], ['Sat', 18, weekCard('Gym', '$40', { badge: 'Auto', balance: '$4,291', delay: 2.4 })]])}
            <div class="tm-legend tm-legend-center tut-in" ${at(3.2)}><span class="is-paid"><i></i>Paid</span><span class="is-upcoming"><i></i>Upcoming</span><span class="is-income"><i></i>Income</span></div>` },
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
        { id: 'list', title: 'Calendar or list', caption: 'Prefer a list? Switch the upcoming view to List any time. Your monthly income and expense history is still a click away further down.',
          render: () => `${chip(5, 'Calendar or list')}
            <div class="tm-row-head"><div><h3>Upcoming payments</h3></div><span class="tm-toggle"><i class="tut-off" ${at(1.6)}>Calendar</i><i class="tut-on" ${at(1.6)} data-id="list">List</i></span></div>
            <div class="tm-swap-block">
              <div class="tut-off" ${at(1.8)}>${week([['Mon', 13, weekCard('Rent', '$1,450', { paid: true })], ['Tue', 14, weekCard('Netflix', '$15', { badge: 'Auto' }), true], ['Wed', 15, weekCard('City Water', '$64', { badge: 'Manual' })], ['Thu', 16, weekCard('Payday', '+$2,100', { tone: 'income' })], ['Fri', 17], ['Sat', 18], ['Sun', 19]])}</div>
              <ul class="tm-list tut-on" ${at(1.8)}>${[['Tue 14', 'Netflix', 'Auto', '$15'], ['Wed 15', 'City Water', 'Manual', '$64'], ['Thu 16', 'Payday', '', '+$2,100'], ['Sat 18', 'Gym', 'Auto', '$40']].map(([d, n, b, a]) => `<li><span>${d}</span><b>${n}</b>${b ? `<i class="tm-badge tm-badge-${b.toLowerCase()}">${b}</i>` : '<i></i>'}<strong>${a}</strong></li>`).join('')}</ul>
            </div>
            <div class="tm-drawer tut-in" ${at(3.4)}>Income &amp; expense history <span>⌄</span></div>
            ${cursor('list', 0.4)}` },
        { id: 'done', title: 'You are ready', caption: 'That is the tour. Check in each morning and let the insights tell you what needs you.',
          render: () => outro("You're ready", 'Insights · the week ahead · paydays', 'Go to your dashboard') }
      ]
    }
  ];
  const ALIASES = { 'debt-strategies': ['debt', 'strategy'], 'debt-dates': ['debt', 'dates'], payoff: ['debt', null], plan: ['debt', null] };

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
