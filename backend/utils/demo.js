import { hashPassword } from './passwords.js';
import { seedUserCategories } from './schema.js';
import { OWNER_USER_ID } from './license.js';

// Public showcase account. The password is intentionally published; all data is rebuilt on every reset.
export const DEMO_EMAIL = 'demo@myfinance.app';
export const DEMO_PASSWORD = 'password1234';
export const DEMO_NAME = 'Demo';
export const isDemoEmail = email => typeof email === 'string' && email.trim().toLowerCase() === DEMO_EMAIL;
export const demoEnabled = (env = process.env) => env.DEMO_ACCOUNT !== 'false';

const DAY_MS = 86400000;
const RESET_HOUR_UTC = 8; // about 3–4 AM US Eastern

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = time => new Date(time).toISOString().slice(0, 10);
const cents = value => Math.round(value * 100) / 100;

// A believable year for one household: salary with a raise, fixed bills (some auto-pay, some manual), subscriptions
// with price increases, seasonal utilities, a summer trip, holiday shopping, one unusual purchase and rising dining.
export function buildDemoData(now = new Date()) {
  const rand = random(20261017);
  const between = (low, high) => low + rand() * (high - low);
  const pick = list => list[Math.floor(rand() * list.length)];
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = end - 364 * DAY_MS;
  const rows = [];
  const add = (time, description, amount, category, { credit = false, fixed = false, payMode = null } = {}) => {
    if (time < start || time > end) return;
    rows.push({ time, date: iso(time), description, amount: cents(amount), direction: credit ? 'CREDIT' : 'DEBIT',
      category, is_fixed: fixed, pay_mode: credit ? null : payMode });
  };

  const firstMonth = new Date(start);
  const endMonthIndex = new Date(end).getUTCFullYear() * 12 + new Date(end).getUTCMonth();
  for (let index = firstMonth.getUTCFullYear() * 12 + firstMonth.getUTCMonth(); index <= endMonthIndex; index++) {
    const year = Math.floor(index / 12), month = index % 12, ago = endMonthIndex - index;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = value => Date.UTC(year, month, Math.min(value, lastDay));
    const bill = (dayOfMonth, description, amount, category, payMode) => add(day(dayOfMonth), description, amount, category, { fixed: true, payMode });
    const winter = [11, 0, 1].includes(month), summer = [6, 7].includes(month), holidays = [10, 11].includes(month);

    bill(1, 'ROCKET MORTGAGE AUTOPAY', 2184.37, 'Mortgage', 'auto');
    bill(6, 'NETFLIX.COM', ago <= 2 ? 17.99 : 15.49, 'Subscriptions', 'auto');
    bill(9, 'GEICO AUTO PAY', ago <= 5 ? 198.52 : 186.4, 'Insurance', 'auto');
    bill(10, 'SPOTIFY USA', 11.99, 'Subscriptions', 'auto');
    bill(12, 'TOYOTA FINANCIAL AUTOPAY', 412.66, 'Car Loans', 'auto');
    bill(14, 'APPLE.COM/BILL', 2.99, 'Subscriptions', 'auto');
    bill(15, 'BILL PAY PSEG ELECTRIC & GAS', 128 + (winter ? 115 : 0) + (summer ? 88 : 0) + between(0, 34), 'Utilities', 'manual');
    bill(17, 'PLANET FITNESS', 24.99, 'Healthcare', 'auto');
    bill(18, 'ONLINE PMT COMCAST XFINITY', ago <= 4 ? 99.99 : 89.99, 'Internet', 'manual');
    bill(22, 'VERIZON WIRELESS AUTOPAY', 142.18, 'Utilities', 'auto');
    bill(25, 'CHASE CARD ONLINE PAYMENT', between(640, 1150), 'Credit Cards', 'manual');
    bill(27, 'BILL PAY TOWNSHIP WATER', between(48, 72), 'Utilities', 'manual');
    bill(28, 'NELNET STUDENT LOAN AUTOPAY', 210, 'Other', 'auto');
    if (ago <= 6) bill(3, 'NYTIMES DIGITAL SUB', 4, 'Subscriptions', 'auto');
    if (ago === 8) add(day(3), 'AMAZON PRIME*MEMBERSHIP', 139, 'Subscriptions', { payMode: 'auto' });

    add(day(20), 'ONLINE TRANSFER TO SAVINGS', 600, 'Savings');
    add(day(4), 'E-ZPASS AUTO REPLENISH', 35, 'Transportation', { payMode: 'auto' });
    add(day(lastDay), 'INTEREST PAYMENT', between(1.6, 3.4), 'Other', { credit: true });
    if (rand() < 0.8) add(day(14), pick(['ZELLE TO JORDAN LEE', 'ZELLE TO SAM PATEL']), pick([60, 75, 100, 120, 150]), 'Transfer');
    if (ago % 5 === 2) add(day(21), 'ZELLE FROM ALEX RIVERA', pick([45, 62.5, 80]), 'Transfer', { credit: true });
    if (month === 3) add(day(11), 'IRS TREAS 310 TAX REF', 1842, 'Other', { credit: true });

    const dining = ago <= 1 ? 1.4 : 1;
    for (let d = 1; d <= lastDay; d++) {
      const weekday = new Date(day(d)).getUTCDay();
      if (weekday === 0) add(day(d), pick(['WHOLE FOODS MARKET', "TRADER JOE'S", 'SHOPRITE']), between(68, 148) * (holidays ? 1.2 : 1), 'Groceries');
      if (weekday === 6 && d <= 7) add(day(d), 'COSTCO WHOLESALE', between(170, 265), 'Groceries');
      if ([1, 3, 5].includes(weekday) && rand() < 0.75) add(day(d), 'STARBUCKS', between(5.45, 9.8), 'Dining');
      if (rand() < 0.2 * dining) add(day(d), pick(['CHIPOTLE', 'SHAKE SHACK', 'DOORDASH', 'SWEETGREEN', 'THE CORNER BISTRO']), between(14, 68), 'Dining');
      if (d % 7 === 2) add(day(d), pick(['SHELL OIL', 'EXXONMOBIL', 'WAWA']), between(38, 61), 'Gas');
      if (rand() < 0.12) add(day(d), 'AMAZON MKTP US', between(12, 118), 'Shopping');
      if (rand() < 0.05) add(day(d), 'TARGET', between(24, 138), 'Shopping');
      if (rand() < 0.05) add(day(d), pick(['UBER TRIP', 'LYFT RIDE']), between(14, 38), 'Transportation');
      if (rand() < 0.045) add(day(d), 'CVS PHARMACY', between(9, 46), 'Healthcare');
    }
    add(day(9), 'HOME DEPOT', [3, 4].includes(month) ? between(260, 480) : between(30, 150), 'Home');
    add(day(16), 'AMC THEATRES', between(28, 46), 'Entertainment');
    if (ago % 4 === 1) add(day(23), 'STEAM GAMES', between(19.99, 59.99), 'Entertainment');
    if (ago % 6 === 3) add(day(19), 'TICKETMASTER', between(180, 320), 'Entertainment');
    if (ago % 4 === 2) add(day(7), 'CITYMD COPAY', 75, 'Healthcare');
    if (holidays) {
      add(day(24), 'BEST BUY 00412', between(240, 420), 'Shopping');
      add(day(28), "MACY'S", between(160, 290), 'Shopping');
      add(day(month === 11 ? 18 : 29), 'APPLE STORE', between(199, 349), 'Shopping');
    }
    if (ago === 4) {
      add(day(5), 'DELTA AIR LINES', 684.2, 'Transportation');
      add(day(13), 'MARRIOTT HOTELS', 912.48, 'Entertainment');
      add(day(14), 'TRATTORIA DEL MARE', 138.6, 'Dining');
      add(day(15), 'HERTZ CAR RENTAL', 286.14, 'Transportation');
    }
  }
  for (let time = start + ((5 - new Date(start).getUTCDay() + 7) % 7) * DAY_MS; time <= end; time += 14 * DAY_MS) {
    add(time, 'NORTHWIND TECH PAYROLL DIR DEP', end - time <= 150 * DAY_MS ? 3586.2 : 3412.55, 'Salary', { credit: true });
  }
  // One clearly unusual purchase in the last week for the anomaly view.
  add(end - 6 * DAY_MS, 'BEST BUY 00412', 1249.99, 'Shopping');

  rows.sort((a, b) => a.time - b.time || (a.direction === b.direction ? 0 : a.direction === 'CREDIT' ? -1 : 1));
  let balance = 6850;
  const transactions = rows.map(({ time, ...row }) => {
    balance = cents(balance + (row.direction === 'CREDIT' ? row.amount : -row.amount));
    return { ...row, balance };
  });

  const ahead = months => iso(Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth() + months, 1));
  return {
    transactions,
    budgets: [['Groceries', 750], ['Dining', 400], ['Shopping', 450], ['Gas', 220], ['Entertainment', 150], ['Subscriptions', 60], ['Transportation', 120]],
    goals: [
      { name: 'Emergency fund', target_amount: 20000, current_amount: 11800, target_date: ahead(10), priority: 1, icon: 'Save', color: '#369c85', notes: 'Six months of essential expenses.' },
      { name: 'Japan trip', target_amount: 6000, current_amount: 1850, target_date: ahead(8), priority: 2, icon: 'Play', color: '#ce7eab', notes: 'Two weeks in Tokyo and Kyoto.' },
      { name: 'New car down payment', target_amount: 8000, current_amount: 2400, target_date: ahead(18), priority: 3, icon: 'Car', color: '#8a9c79', notes: null }
    ],
    debts: [
      { name: 'Chase Sapphire', balance: 3840.12, apr: 24.99, credit_limit: 12000, min_payment: 95, due_date: '25', debt_type: 'credit_card', payment_in_history: true },
      { name: 'Toyota auto loan', balance: 14620.55, apr: 5.9, credit_limit: 0, min_payment: 412.66, due_date: '12', debt_type: 'auto_loan', payment_in_history: true },
      { name: 'Nelnet student loan', balance: 18210.4, apr: 4.5, credit_limit: 0, min_payment: 210, due_date: '28', debt_type: 'student_loan', payment_in_history: true }
    ],
    rules: [
      ['WHOLE FOODS|TRADER JOE|SHOPRITE|COSTCO', 'Grocery stores', 'Groceries'],
      ['STARBUCKS|CHIPOTLE|SHAKE SHACK|DOORDASH|SWEETGREEN', 'Restaurants & coffee', 'Dining'],
      ['SHELL OIL|EXXONMOBIL|WAWA', 'Gas stations', 'Gas'],
      ['NETFLIX|SPOTIFY|APPLE\\.COM/BILL|NYTIMES', 'Streaming & apps', 'Subscriptions'],
      ['AMAZON MKTP|TARGET', 'Online & big-box shopping', 'Shopping']
    ]
  };
}

// Rebuilds the demo user and every row it owns. Must run on the administrative connection inside a transaction.
export async function resetDemoAccount(client, now = new Date()) {
  const data = buildDemoData(now);
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const existing = (await client.query('SELECT id FROM users WHERE lower(email)=$1', [DEMO_EMAIL])).rows[0];
  if (existing && Number(existing.id) === OWNER_USER_ID) throw new Error('The owner account cannot be used as the demo account');
  const userId = existing
    ? (await client.query("UPDATE users SET name=$2, role='user', password_hash=$3 WHERE id=$1 RETURNING id", [existing.id, DEMO_NAME, passwordHash])).rows[0].id
    : (await client.query("INSERT INTO users (name,email,role,password_hash) VALUES ($1,$2,'user',$3) RETURNING id", [DEMO_NAME, DEMO_EMAIL, passwordHash])).rows[0].id;

  // Row-level security limits every statement below to the demo user's rows.
  await client.query('SET LOCAL ROLE finance_app_runtime');
  await client.query("SELECT set_config('app.user_id', $1, true)", [String(userId)]);
  for (const table of ['transactions', 'staging_transactions', 'category_budgets', 'savings_goals', 'credit_cards', 'transaction_labels', 'categories']) {
    await client.query(`DELETE FROM ${table}`);
  }
  await seedUserCategories(client, userId);
  const column = key => data.transactions.map(row => row[key]);
  await client.query(`INSERT INTO transactions (date,description,amount,direction,balance,source,category,is_fixed,pay_mode)
    SELECT d, de, a, di, b, 'demo', c, f, p
    FROM unnest($1::text[], $2::text[], $3::numeric[], $4::text[], $5::numeric[], $6::text[], $7::boolean[], $8::text[]) AS t(d, de, a, di, b, c, f, p)`,
  [column('date'), column('description'), column('amount'), column('direction'), column('balance'), column('category'), column('is_fixed'), column('pay_mode')]);
  for (const [pattern, label, category] of data.rules) {
    await client.query(`INSERT INTO transaction_labels (pattern,display_label,category_id,match_type,enabled,priority)
      SELECT $1,$2,id,'regex',TRUE,1 FROM categories WHERE name=$3`, [pattern, label, category]);
  }
  for (const [category, amount] of data.budgets) {
    await client.query('INSERT INTO category_budgets (category,monthly_amount) VALUES ($1,$2)', [category, amount]);
  }
  for (const goal of data.goals) {
    await client.query(`INSERT INTO savings_goals (name,target_amount,current_amount,target_date,priority,icon,color,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [goal.name, goal.target_amount, goal.current_amount, goal.target_date, goal.priority, goal.icon, goal.color, goal.notes]);
  }
  for (const debt of data.debts) {
    await client.query(`INSERT INTO credit_cards (name,balance,apr,credit_limit,min_payment,due_date,debt_type,payment_in_history)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [debt.name, debt.balance, debt.apr, debt.credit_limit, debt.min_payment, debt.due_date, debt.debt_type, debt.payment_in_history]);
  }
  await client.query('RESET ROLE');
  return { userId: Number(userId), transactions: data.transactions.length };
}

export const msUntilNextReset = (now = new Date()) => {
  const next = new Date(now);
  next.setUTCHours(RESET_HOUR_UTC, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
};

// Runs once now (on every start/deploy) and then nightly. Failures are reported but never stop the server.
export function startDemoResets(run, onError) {
  const safeRun = () => Promise.resolve().then(run).catch(onError);
  const timer = setTimeout(() => {
    safeRun();
    setInterval(safeRun, DAY_MS).unref?.();
  }, msUntilNextReset());
  timer.unref?.();
  return safeRun();
}
