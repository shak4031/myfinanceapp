import { administrativeTransaction } from '../db.js';

export const OWNER_USER_ID = 1;
export const TRIAL_DAYS = 7;
export const PLAN = Object.freeze({ id: 'pro', name: 'MyFinance Pro', price: 4.99, currency: 'USD', interval: 'month' });
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
export function entitlementFromRow(userId, row, now = new Date()) {
  const base = { plan: PLAN, features: PRO_FEATURES };
  if (Number(userId) === OWNER_USER_ID) return { ...base, tier: 'pro', source: 'owner', active: true, trialAvailable: false };
  if (row?.granted_at && !row.revoked_at) {
    return { ...base, tier: 'pro', source: 'license', active: true, trialAvailable: false, grantedAt: row.granted_at };
  }
  const trialEnds = row?.trial_ends_at ? new Date(row.trial_ends_at) : null;
  if (trialEnds && trialEnds > now && !row.revoked_at) {
    return {
      ...base, tier: 'trial', source: 'trial', active: true, trialAvailable: false,
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
  return (await client.query('SELECT * FROM user_licenses WHERE user_id=$1', [userId])).rows[0];
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

export async function setLicense(client, userId, action, actorId) {
  const row = action === 'grant'
    ? (await client.query(`
        INSERT INTO user_licenses (user_id, granted_at, granted_by, revoked_at, updated_at) VALUES ($1,NOW(),$2,NULL,NOW())
        ON CONFLICT (user_id) DO UPDATE SET granted_at=NOW(), granted_by=$2, revoked_at=NULL, updated_at=NOW()
        RETURNING *`, [userId, actorId])).rows[0]
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
