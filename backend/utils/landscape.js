import { accountBalances, isTransferRow, ACCOUNT_KIND_LABELS } from './transfers.js';
import { bucketOf, debtMatchers } from './spendingBuckets.js';
import { getCanonicalMerchant, parseTxDate } from './normalize.js';

const round = value => Math.round(value * 100) / 100;
const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const retirementSubtype = /^(?:401k|403b|457b|401a|ira|roth|roth 401k|pension|retirement|sep ira|simple ira|keogh|profit sharing plan)$/i;
const retirementName = /\b(?:401\s*\(?k\)?|403\s*\(?b\)?|457\s*\(?b\)?|IRA|retirement|pension)\b/i;
export const LANDSCAPE_BRANCHES = [
  ['income', 'Money in', '#147d64'], ['spending', 'Spending', '#b25072'],
  ['debt', 'Debt', '#af5927'], ['cash', 'Cash / other accounts', '#246b9e'],
  ['savings', 'Savings', '#30836b'], ['investments', 'Investments', '#7651a8'],
  ['retirement', 'Retirement / 401(k)', '#85652a'], ['goals', 'Goals', '#357c89']
];

export function buildLandscape({ accounts = [], transactions = [], banks = [], debts = [], goals = [], now = new Date() } = {}) {
  const nodes = [], edges = [];
  const add = node => { nodes.push(node); return node; };
  const edge = (source, target, kind, extra = {}) => edges.push({ source, target, kind, ...extra });
  add({ id: 'household', kind: 'household', label: 'Your financial landscape', note: 'Relationships in your saved data, not a net-worth calculation.' });
  for (const [id, label, color] of LANDSCAPE_BRANCHES) {
    add({ id, label, color, kind: 'branch', branch: id, amount: null, metric: 'connections' });
    edge('household', id, 'structure');
  }
  const local = new Map(accounts.filter(account => account.status === 'active' && !['external', 'unknown'].includes(account.kind)).map(account => [account.id, account]));
  const bankByAccount = new Map();
  for (const bank of banks) {
    if (!local.has(bank.linked_account_id) || bank.account_link_error) continue;
    const matches = banks.filter(other => other.linked_account_id === bank.linked_account_id);
    if (matches.length === 1) bankByAccount.set(bank.linked_account_id, bank);
  }
  const accountByProvider = new Map([...bankByAccount].map(([id, bank]) => [bank.account_id, id]));
  const accountOf = tx => local.has(tx.account_id) ? tx.account_id : accountByProvider.get(tx.plaid_account_id);
  const today = now.toISOString().slice(0, 10);
  const balanceAccounts = [...local.values()].map(account => account.statement?.closingDate > today
    ? { ...account, statement: null } : account);
  const balances = accountBalances(transactions.filter(tx => !tx.is_pending && parseTxDate(tx.date)?.iso <= today), balanceAccounts);
  const debtByAccount = new Map();
  for (const debt of debts) {
    if (local.has(debt.account_id)) {
      if (!debtByAccount.has(debt.account_id)) debtByAccount.set(debt.account_id, []);
      debtByAccount.get(debt.account_id).push(debt);
    }
  }
  for (const account of local.values()) {
    const bank = bankByAccount.get(account.id);
    const statement = balances.get(account.id);
    const bankDate = bank?.balance_checked_at ? new Date(bank.balance_checked_at).toISOString() : null;
    const useBank = bank && bank.iso_currency_code === 'USD' && number(bank.current_balance) !== null
      && bankDate && (!statement || bankDate.slice(0, 10) >= statement.asOf);
    const retirement = retirementSubtype.test(bank?.subtype || '') || (account.kind === 'investment' && retirementName.test(account.name || ''));
    const branch = retirement ? 'retirement' : account.kind === 'savings' ? 'savings'
      : ['investment', 'crypto'].includes(account.kind) ? 'investments'
        : ['loan', 'credit_card'].includes(account.kind) || debtByAccount.has(account.id) ? 'debt' : 'cash';
    const amount = useBank ? number(bank.current_balance) : statement?.balance ?? null;
    add({ id: `account-${account.id}`, kind: 'account', branch, label: account.name,
      amount, metric: 'balance', asOf: useBank ? bankDate : statement?.asOf || null,
      source: useBank ? 'Plaid current balance (USD)' : statement ? 'Recorded statement / transaction balance' : 'No balance recorded',
      note: `${ACCOUNT_KIND_LABELS[account.kind] || account.kind}. ${account.kind === 'other' ? 'Account type is unspecified; this is not confirmed cash. ' : ''}${retirement ? 'Retirement grouping uses the saved subtype or account name; holdings and employer contributions are not available. ' : ''}${branch === 'investments' ? 'Account balance only; holdings and investment performance are not available. ' : ''}Balances may have different dates. No balance is inferred from deposits or spending.`,
      href: '#accounts', debts: (debtByAccount.get(account.id) || []).map(debt => ({
        label: debt.name, balance: number(debt.balance), minimum: number(debt.min_payment)
      })) });
    edge(branch, `account-${account.id}`, 'structure');
  }
  for (const debt of debts.filter(debt => !local.has(debt.account_id))) {
    add({ id: `debt-${debt.id}`, kind: 'debt', branch: 'debt', label: debt.name,
      amount: number(debt.balance), metric: 'balance', source: 'Saved debt-plan balance; as-of date unavailable',
      note: 'Not linked to an account. May overlap an imported debt account; balances are not added into a net-worth total.',
      minimum: number(debt.min_payment), href: '#payoff' });
    edge('debt', `debt-${debt.id}`, 'structure');
  }
  for (const goal of goals) {
    add({ id: `goal-${goal.id}`, kind: 'goal', branch: 'goals', label: goal.name,
      amount: number(goal.current_amount), target: number(goal.target_amount), metric: 'goal-progress',
      source: 'Saved goal progress', note: 'Goal progress is a planning amount, not an additional bank balance. It is not added to savings.', href: '#goals' });
    edge('goals', `goal-${goal.id}`, 'structure');
  }

  const current = now.getFullYear() * 12 + now.getMonth();
  const monthKey = index => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
  const from = monthKey(current - 3), to = monthKey(current - 1);
  const posted = transactions.filter(tx => {
    const date = parseTxDate(tx.date)?.iso;
    return !tx.is_pending && date && date.slice(0, 7) >= from && date.slice(0, 7) <= to
      && number(tx.amount) !== null && Number(tx.amount) > 0;
  });
  const months = new Set(posted.map(tx => parseTxDate(tx.date).iso.slice(0, 7))).size;
  const divisor = months || 1, matchers = debtMatchers(debts);
  const groups = new Map(), flows = new Map(), totals = new Map();
  const income = posted.filter(tx => !isTransferRow(tx) && tx.direction?.toUpperCase() === 'CREDIT');
  const payments = posted.filter(tx => bucketOf(tx, matchers));
  const groupFor = (branch, label) => {
    const key = `${branch}:${label}`;
    if (!groups.has(key)) {
      const id = `activity-${groups.size}`;
      const node = add({ id, branch, kind: 'activity', label, amount: 0, metric: 'monthly', count: 0,
        source: `${months} recorded completed month${months === 1 ? '' : 's'} within ${from} through ${to}`,
        note: branch === 'income' ? 'Recorded non-transfer credits, which can include refunds and one-off deposits. Not all money in is salary.' : 'Recorded non-transfer payments. Debt payments are separate from other spending.',
        transactions: [] });
      groups.set(key, node);
      edge(branch, id, 'structure');
    }
    return groups.get(key);
  };
  for (const tx of [...income, ...payments]) {
    const bucket = bucketOf(tx, matchers);
    const branch = bucket ? bucket.bucket === 'debt' ? 'debt' : 'spending' : 'income';
    const label = branch === 'income' ? tx.display_name || getCanonicalMerchant(tx.description) || 'Other money in'
      : `${bucket.bucket === 'fixed' ? 'Fixed: ' : ''}${tx.category || 'Uncategorized'}`;
    const node = groupFor(branch, label);
    node.amount += Number(tx.amount);
    totals.set(branch, (totals.get(branch) || 0) + Number(tx.amount));
    node.count++;
    node.transactions.push({ id: tx.id, date: parseTxDate(tx.date).iso, label: tx.display_name || tx.description, amount: Number(tx.amount) });
    const id = accountOf(tx);
    if (id != null) {
      const source = branch === 'income' ? node.id : `account-${id}`;
      const target = branch === 'income' ? `account-${id}` : node.id;
      const key = `${source}:${target}`;
      if (!flows.has(key)) flows.set(key, { source, target, amount: 0, count: 0 });
      const flow = flows.get(key);
      flow.amount += Number(tx.amount);
      flow.count++;
    }
  }
  for (const node of groups.values()) {
    node.amount = round(node.amount / divisor);
    node.transactions.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    node.transactions = node.transactions.slice(0, 20);
  }
  for (const flow of flows.values()) edge(flow.source, flow.target, 'activity', { amount: round(flow.amount / divisor), count: flow.count });
  const seenTransfers = new Set(), transferFlows = new Map();
  for (const tx of posted.filter(tx => tx.transfer_kind === 'savings' || tx.transfer_kind === 'internal')) {
    const own = accountOf(tx), other = tx.transfer_account_id;
    if (!local.has(own) || !local.has(other) || own === other) continue;
    const key = tx.transfer_pair_id ? [tx.id, tx.transfer_pair_id].sort((a, b) => a - b).join(':') : String(tx.id);
    if (seenTransfers.has(key)) continue;
    seenTransfers.add(key);
    const debit = tx.direction?.toUpperCase() === 'DEBIT';
    const source = `account-${debit ? own : other}`, target = `account-${debit ? other : own}`;
    const flowKey = `${source}:${target}`;
    if (!transferFlows.has(flowKey)) transferFlows.set(flowKey, { source, target, amount: 0, count: 0 });
    const flow = transferFlows.get(flowKey);
    flow.amount += Number(tx.amount);
    flow.count++;
  }
  for (const flow of transferFlows.values()) edge(flow.source, flow.target, 'transfer', { amount: round(flow.amount / divisor), count: flow.count });
  for (const [id] of LANDSCAPE_BRANCHES) {
    const branch = nodes.find(node => node.id === id);
    const children = nodes.filter(node => node.branch === id && node.kind !== 'branch');
    branch.count = children.length;
    if (id === 'income' || id === 'spending') {
      branch.amount = months ? round((totals.get(id) || 0) / divisor) : null;
      branch.metric = 'monthly';
    }
    branch.note = id === 'debt' ? 'Debt balances and recorded monthly payments are different measures. Linked debt-plan records appear inside their account; unlinked records may overlap.'
      : id === 'income' ? 'Recorded money in includes refunds and one-off credits, not just take-home pay.'
        : id === 'spending' ? 'Fixed and discretionary payments, excluding transfers and debt payments.'
          : id === 'goals' ? 'Planning progress only, not extra assets.'
            : 'Known accounts only. Missing balances stay unavailable, never zero. No net worth is calculated.';
    if (!children.length) {
      add({ id: `missing-${id}`, branch: id, kind: 'missing', label: id === 'retirement' ? '401(k) / retirement coverage missing'
        : id === 'investments' ? 'Investment coverage missing' : `No ${branch.label.toLowerCase()} recorded`,
      amount: null, metric: 'missing', note: 'No matching data is available. This does not mean you have no accounts or money here. This map does not add live investment or 401(k) integration.', href: '#accounts' });
      edge(id, `missing-${id}`, 'structure');
    }
  }
  return { nodes, edges, period: { from, to, months }, generatedAt: now.toISOString(),
    coverage: { pendingExcluded: transactions.filter(tx => tx.is_pending).length,
      unknownTransfers: posted.filter(tx => tx.transfer_kind === 'unknown').length,
      unassignedActivity: [...income, ...payments].filter(tx => accountOf(tx) == null).length,
      reviewAccounts: accounts.filter(account => account.status !== 'active' || account.kind === 'unknown').length },
    note: 'A relationship map, not a complete net-worth statement. Monthly activity uses posted records in the last three completed months, averaged over months with records. Missing imports can make totals incomplete. Transfers are connections, not spending or income. No invented account links.' };
}
