import { administrativeTransaction } from '../db.js';
import { isDemoEmail } from './demo.js';

export const OWNER_USER_ID = 1;
export const TRIAL_DAYS = 15;
export const PLAN = Object.freeze({ id: 'basic', name: 'MyFinance Basic', price: 9.99, currency: 'USD', interval: 'month' });
export const PLUS_PLAN = Object.freeze({ id: 'pro', name: 'MyFinance Pro', price: 14.99, currency: 'USD', interval: 'month' });
export const PLUS_FEATURES = Object.freeze([
  { id: 'planning', title: 'Debt-free plan', text: 'Compare payoff strategies, see an estimated debt-free date and explore extra-payment what-ifs.' },
  { id: 'goals', title: 'Savings goals', text: 'Plan for emergencies, a home, a trip or college with monthly targets and progress tracking.' }
]);
export const PRO_FEATURES = Object.freeze([
  { id: 'insights', title: 'Spending insights', text: 'Delta vs last month, moving averages and trend signals per category.' },
  { id: 'budgets', title: 'Budgets', text: 'Monthly budgets per category with live progress and projected overspend.' },
  { id: 'charts', title: 'Charts', text: 'Category pie view and month-by-month histograms on every category card.' },
  { id: 'forecast', title: 'Forecasts', text: 'Month-end spend forecast and a 6-month cash-flow projection.' },
  { id: 'subscriptions', title: 'Recurring charges', text: 'Repeating payments not marked as fixed bills, with annual cost and price-increase alerts.' },
  { id: 'money-flow', title: 'Spending Compass', text: 'Your spending against similar households, with trend, momentum and breakout signals that point to realistic savings.' },
  { id: 'anomalies', title: 'Unusual activity', text: 'Charges that are far above normal for a merchant or category.' },
  { id: 'export', title: 'Export', text: 'Download filtered transactions and analytics as CSV.' }
]);

const DAY_MS = 86400000;

export const PLAN_IDS = Object.freeze(['basic', 'pro']);

// Pure so it can be tested without a database.
export function entitlementFromRow(userId, row, now = new Date(), email = row?.email) {
  const entitlement = baseEntitlement(userId, row, now, email);
  return entitlement;
}

function baseEntitlement(userId, row, now, email) {
  const base = { plan: PLAN, plusPlan: PLUS_PLAN, features: PRO_FEATURES, plusFeatures: PLUS_FEATURES, plusActive: false };
  if (Number(userId) === OWNER_USER_ID) return { ...base, tier: 'pro', source: 'owner', active: true, plusActive: true, trialAvailable: false };
  if (isDemoEmail(email)) return { ...base, tier: 'pro', source: 'demo', active: true, plusActive: true, trialAvailable: false };
  if (row?.granted_at && !row.revoked_at) {
    const plusActive = row.plan === 'pro';
    return { ...base, tier: plusActive ? 'pro' : 'basic', source: 'license', active: true, plusActive, trialAvailable: false, grantedAt: row.granted_at };
  }
  const subscription = row?.subscription;
  if (subscription?.status === 'trialing' && new Date(subscription.trial_ends_at) > now) {
    const trialEnds = new Date(subscription.trial_ends_at);
    return { ...base, tier: 'trial', source: 'trial', active: true, plusActive: true, trialAvailable: false,
      trialEndsAt: trialEnds.toISOString(), daysLeft: Math.max(1, Math.ceil((trialEnds - now) / DAY_MS)) };
  }
  if (subscription?.status === 'active' && new Date(subscription.current_period_end) > now) {
    return { ...base, tier: subscription.plan, source: 'stripe', active: true, plusActive: subscription.plan === 'pro', trialAvailable: false };
  }
  const trialEnds = row?.trial_ends_at ? new Date(row.trial_ends_at) : null;
  return {
    ...base, tier: 'none', source: trialEnds || subscription?.trial_used ? 'trial-expired' : 'none', active: false,
    trialAvailable: !row?.trial_started_at && !subscription?.trial_used,
    ...(trialEnds ? { trialEndsAt: trialEnds.toISOString() } : {})
  };
}

async function loadRow(client, userId) {
  return (await client.query(`SELECT l.*,u.email,h.owner_user_id AS tenant_id,to_jsonb(s) AS subscription
    FROM users login JOIN household_members m ON m.user_id=login.id JOIN households h ON h.id=m.household_id
    JOIN users u ON u.id=h.owner_user_id LEFT JOIN user_licenses l ON l.user_id=u.id
    LEFT JOIN household_subscriptions s ON s.household_id=h.id WHERE login.id=$1`, [userId])).rows[0];
}

export async function getEntitlement(userId) {
  if (Number(userId) === OWNER_USER_ID) return entitlementFromRow(userId, null);
  return administrativeTransaction(async client => {
    const row = await loadRow(client, userId);
    return entitlementFromRow(row?.tenant_id || userId, row);
  });
}

export async function startTrial(userId, now = new Date()) {
  return { ok: false, status: 409, error: 'Choose a plan and add payment details in Stripe Checkout to start your 15-day Pro trial.', entitlement: await getEntitlement(userId) };
}

export async function setLicense(client, userId, action, actorId, plan = 'pro') {
  const membership = (await client.query(`SELECT h.owner_user_id FROM household_members m
    JOIN households h ON h.id=m.household_id WHERE m.user_id=$1`, [userId])).rows[0];
  userId = membership?.owner_user_id || userId;
  if (userId === OWNER_USER_ID) throw Object.assign(new Error('The owner household always includes Pro.'), { status: 400 });
  const row = action === 'grant'
    ? (await client.query(`
        INSERT INTO user_licenses (user_id, plan, granted_at, granted_by, revoked_at, updated_at) VALUES ($1,$3,NOW(),$2,NULL,NOW())
        ON CONFLICT (user_id) DO UPDATE SET plan=$3, granted_at=NOW(), granted_by=$2, revoked_at=NULL,
          requested_plan=NULL, requested_at=NULL, updated_at=NOW()
        RETURNING *`, [userId, actorId, plan])).rows[0]
    : (await client.query(`
        INSERT INTO user_licenses (user_id, revoked_at, updated_at) VALUES ($1,NOW(),NOW())
        ON CONFLICT (user_id) DO UPDATE SET granted_at=NULL, granted_by=NULL, revoked_at=NOW(), updated_at=NOW()
        RETURNING *`, [userId])).rows[0];
  return entitlementFromRow(userId, row);
}

// Records which paid plan the customer chose; an administrator approves it by granting that plan.
export async function requestPlan(userId, plan, now = new Date()) {
  return { ok: false, status: 409, error: 'Use Stripe Checkout to select Basic or Pro.', entitlement: await getEntitlement(userId) };
}

export async function cancelPlanRequest(userId) {
  return administrativeTransaction(async client => {
    await client.query('UPDATE user_licenses SET requested_plan=NULL, requested_at=NULL, updated_at=NOW() WHERE user_id=$1', [userId]);
    return entitlementFromRow(userId, await loadRow(client, userId));
  });
}

export function requirePro(req, res, next) {
  getEntitlement(req.user.id).then(entitlement => {
    req.entitlement = entitlement;
    if (entitlement.plusActive) return next();
    res.status(402).json({ error: 'This feature is part of MyFinance Pro', code: 'PRO_REQUIRED', entitlement });
  }, next);
}

export function requireProPlus(req, res, next) {
  getEntitlement(req.user.id).then(entitlement => {
    req.entitlement = entitlement;
    if (entitlement.plusActive) return next();
    res.status(402).json({ error: 'Debt Free and Savings Goals require MyFinance Pro', code: 'PRO_REQUIRED', entitlement });
  }, next);
}
