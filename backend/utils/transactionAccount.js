export const TRANSACTION_ACCOUNT_JOINS = `
  LEFT JOIN accounts a ON a.id=t.account_id AND a.user_id=t.user_id
  LEFT JOIN plaid_accounts pa ON pa.account_id=t.plaid_account_id AND pa.user_id=t.user_id
  LEFT JOIN plaid_connections pc ON pc.id=pa.connection_id AND pc.user_id=t.user_id`;

export const TRANSACTION_ACCOUNT_FIELDS = `
  CASE WHEN pa.id IS NOT NULL THEN 'plaid:' || pa.id::text
    WHEN a.id IS NOT NULL THEN 'account:' || a.id::text
    ELSE 'unassigned' END AS account_key,
  COALESCE(pa.name,a.name) AS account_name,
  COALESCE(CASE pa.type
    WHEN 'credit' THEN 'credit_card'
    WHEN 'depository' THEN CASE WHEN pa.subtype IN ('checking','savings') THEN pa.subtype ELSE 'depository' END
    WHEN 'loan' THEN 'loan'
    WHEN 'investment' THEN 'investment'
    ELSE NULL END,a.kind) AS account_kind,
  COALESCE(pa.mask,a.last4) AS account_last4,
  COALESCE(pc.institution_name,a.institution) AS account_institution`;

export function sameSourceAccount(a, b) {
  if (a.plaid_account_id != null && b.plaid_account_id != null) {
    return String(a.plaid_account_id) === String(b.plaid_account_id);
  }
  if (a.account_id != null && b.account_id != null) return String(a.account_id) === String(b.account_id);
  const identified = tx => tx.account_id != null || tx.plaid_account_id != null;
  const identity = tx => {
    const institution = String(tx.account_institution || '').trim().toLowerCase();
    const mask = String(tx.account_last4 || '');
    const kind = tx.account_kind;
    return institution && /^\d{4}$/.test(mask) && kind && !['unknown', 'other', 'depository'].includes(kind)
      ? JSON.stringify([institution, mask, kind]) : null;
  };
  const left = identity(a);
  return identified(a) && identified(b) && !!left && left === identity(b);
}

export function sourceAccountsCompatible(a, b) {
  if (a.plaid_account_id != null && b.plaid_account_id != null && String(a.plaid_account_id) !== String(b.plaid_account_id)) return false;
  if (a.account_id != null && b.account_id != null && String(a.account_id) !== String(b.account_id)) return false;
  const crossSource = (a.account_id != null && a.plaid_account_id == null && b.plaid_account_id != null && b.account_id == null)
    || (b.account_id != null && b.plaid_account_id == null && a.plaid_account_id != null && a.account_id == null);
  return !crossSource || sameSourceAccount(a, b);
}
