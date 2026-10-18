import { administrativeTransaction } from '../db.js';
import { isDemoEmail } from './demo.js';

export const OWNER_USER_ID = 1;
export const TRIAL_DAYS = 7;
export const PLAN = Object.freeze({ id: 'pro', name: 'MyFinance Pro', price: 4.99, currency: 'USD', interval: 'month' });
export const PLUS_PLAN = Object.freeze({ id: 'pro_plus', name: 'MyFinance Pro Plus', price: 9.98, additionalPrice: 4.99, currency: 'USD', interval: 'month' });
export const PLUS_FEATURES = Object.freeze([
  { id: 'planning', title: 'Debt-free plan', text: 'Compare payoff strategies, see an estimated debt-free date and explore extra-payment what-ifs.' },
  { id: 'goals', title: 'Savings goals', text: 'Plan for emergencies, a home, a trip or college with monthly targets and progress tracking.' }
]);
export const PRO_FEATURES = Object.freeze([
  { id: 'insights', title: 'Spending insights', text: 'Delta vs last month, moving averages and trend signals per category.' },
  { id: 'budgets', title: 'Budgets', text: 'Monthly budgets per category with live progress and projected overspend.' },
  { id: 'charts', title: 'Charts', text: 'Category pie view and month-by-month histograms on every category card.' },
  { id: 'forecast', title: 'Forecasts', text: 'Month-end spend forecast and a 6-month cash-flow projection.' },
  { id: 'subscriptions', title: 'Subscription radar', text: 'Recurring charges, annual cost and price-increase alerts.' },
  { id: 'anomalies', title: 'Unusual activity', text: 'Charges that are far above normal for a merchant or category.' },
  { id: 'export', title: 'Export', text: 'Download filtered transactions and analytics as CSV.' }
]);

const DAY_MS = 86400000;

// Pure so it can be tested without a database.
export function entitlementFromRow(userId, row, now = new Date(), email = row?.email) {
  const base = { plan: PLAN, plusPlan: PLUS_PLAN, features: PRO_FEATURES, plusFeatures: PLUS_FEATURES, plusActive: false };
  if (Number(userId) === OWNER_USER_ID) return { ...base, tier: 'pro', source: 'owner', active: true, plusActive: true, trialAvailable: false };
  if (isDemoEmail(email)) return { ...base, tier: 'pro', source: 'demo', active: true, plusActive: true, trialAvailable: false };
  if (row?.granted_at && !row.revoked_at) {
    const plusActive = row.plan === 'pro_plus';
    return { ...base, tier: plusActive ? 'pro_plus' : 'pro', source: 'license', active: true, plusActive, trialAvailable: false, grantedAt: row.granted_at };
  }
  const trialEnds = row?.trial_ends_at ? new Date(row.trial_ends_at) : null;
  if (trialEnds && trialEnds > now && !row.revoked_at) {
    return {
      ...base, tier: 'trial', source: 'trial', active: true, plusActive: true, trialAvailable: false,
      trialEndsAt: trialEnds.toISOString(), daysLeft: Math.max(1, Math.ceil((trialEnds - now) / DAY_MS))
    };
  }
  return {
    ...base, tier: 'free', source: trialEnds ? 'trial-expired' : 'none', active: false,
    trialAvailable: !row?.trial_started_at,
    ...(trialEnds ? { trialEndsAt: trialEnds.toISOString() } : {})
  };
}

async function loadRow(client, userId) {
  return (await client.query(`SELECT l.*, u.email FROM users u LEFT JOIN user_licenses l ON l.user_id = u.id
    WHERE u.id=$1`, [userId])).rows[0];
}

export async function getEntitlement(userId) {
  if (Number(userId) === OWNER_USER_ID) return entitlementFromRow(userId, null);
  return administrativeTransaction(async client => entitlementFromRow(userId, await loadRow(client, userId)));
}

export async function startTrial(userId, now = new Date()) {
  return administrativeTransaction(async client => {
    const row = await loadRow(client, userId);
    const current = entitlementFromRow(userId, row, now);
    if (current.active) return { ok: false, status: 409, error: 'MyFinance Pro is already active on this account', entitlement: current };
    if (row?.trial_started_at) return { ok: false, status: 409, error: 'The free trial has already been used on this account', entitlement: current };
    const ends = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
    const saved = (await client.query(`
      INSERT INTO user_licenses (user_id, trial_started_at, trial_ends_at, updated_at) VALUES ($1,$2,$3,NOW())
      ON CONFLICT (user_id) DO UPDATE SET trial_started_at=$2, trial_ends_at=$3, updated_at=NOW()
      RETURNING *`, [userId, now.toISOString(), ends.toISOString()])).rows[0];
    return { ok: true, entitlement: entitlementFromRow(userId, saved, now) };
  });
}

export async function setLicense(client, userId, action, actorId, plan = 'pro') {
  const row = action === 'grant'
    ? (await client.query(`
        INSERT INTO user_licenses (user_id, plan, granted_at, granted_by, revoked_at, updated_at) VALUES ($1,$3,NOW(),$2,NULL,NOW())
        ON CONFLICT (user_id) DO UPDATE SET plan=$3, granted_at=NOW(), granted_by=$2, revoked_at=NULL, updated_at=NOW()
        RETURNING *`, [userId, actorId, plan])).rows[0]
    : (await client.query(`
        INSERT INTO user_licenses (user_id, revoked_at, updated_at) VALUES ($1,NOW(),NOW())
        ON CONFLICT (user_id) DO UPDATE SET granted_at=NULL, granted_by=NULL, revoked_at=NOW(), updated_at=NOW()
        RETURNING *`, [userId])).rows[0];
  return entitlementFromRow(userId, row);
}

export function requirePro(req, res, next) {
  getEntitlement(req.user.id).then(entitlement => {
    req.entitlement = entitlement;
    if (entitlement.active) return next();
    res.status(402).json({ error: 'This feature is part of MyFinance Pro', code: 'PRO_REQUIRED', entitlement });
  }, next);
}

export function requireProPlus(req, res, next) {
  getEntitlement(req.user.id).then(entitlement => {
    req.entitlement = entitlement;
    if (entitlement.plusActive) return next();
    res.status(402).json({ error: 'Debt Free and Savings Goals require MyFinance Pro Plus', code: 'PRO_PLUS_REQUIRED', entitlement });
  }, next);
}
