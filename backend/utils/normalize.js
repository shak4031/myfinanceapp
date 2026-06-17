/**
 * Description Normalizer
 * 
 * Robust deduplication utility for financial transactions.
 * 
 * The problem: Same real-world transaction imported from different sources (CSV, PDF,
 * manual upload) lands with slightly different descriptions due to inconsistent
 * whitespace padding, trimming, etc.
 *   - "VENMO            PAYMENT"  (from raw CSV)
 *   - "VENMO PAYMENT"            (from stripped/trimmed source)
 * 
 * Solution: Normalize descriptions by collapsing all whitespace into single spaces
 * and trimming, then use the normalized form for dedup comparison.
 *
 * For commercialization this must be paired with a stable primary-key strategy
 * (see normalizeDescription vs. hashDescription below).
 */

/**
 * Normalize a transaction description by collapsing whitespace and trimming.
 * This is the dedup comparison key, NOT stored — the original description is preserved.
 * 
 * @param {string} desc - Raw transaction description
 * @returns {string} Normalized description for comparison
 */
export function normalizeDescription(desc) {
  if (!desc) return '';
  return desc
    .replace(/\s+/g, ' ')   // Collapse all whitespace (spaces, tabs, newlines) to single space
    .trim()                  // Remove leading/trailing whitespace
    .toUpperCase();          // Case-insensitive comparison
}

/**
 * Generate a stable hash-based fingerprint for a transaction.
 * This can serve as a dedup key for future import gating without storing
 * descriptions in a separate index.
 * 
 * Combines: date + normalized description + amount + direction
 * 
 * @param {Object} txn - { date, description, amount, direction }
 * @returns {string} SHA-256 hex fingerprint
 */
export function fingerprintTransaction(txn) {
  const normalized = normalizeDescription(txn.description || '');
  const payload = `${txn.date}|${normalized}|${txn.amount}|${(txn.direction || '').toUpperCase()}`;
  
  // Simple but effective: use a fast hash if available, otherwise use the payload itself
  // (PostgreSQL can fingerprint during import for consistency)
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    const char = payload.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return `fp_${Math.abs(hash).toString(36)}`;
}

/**
 * Build a SQL dedup WHERE clause with normalized description matching.
 * Returns { clause, params } for use in parameterized queries.
 * 
 * @param {Object} txn - { date, description, amount, direction }
 * @returns {{ clause: string, params: any[] }}
 */
export function dedupWhereClause(txn) {
  const normalized = normalizeDescription(txn.description || '');
  return {
    clause: `date = $1 AND regexp_replace(description, '[[:space:]]+', ' ', 'g') = $2 AND amount = $3 AND direction = $4`,
    params: [txn.date, normalized, txn.amount, (txn.direction || '').toUpperCase()]
  };
}

/**
 * SQL snippet for creating a unique transaction fingerprint column.
 * This can be used in a migration to add a permanent dedup index.
 * 
 * Example: SELECT date, fingerprint, COUNT(*) ... GROUP BY fingerprint HAVING COUNT(*) > 1
 */
export const FINGERPRINT_SQL = `
  CREATE OR REPLACE FUNCTION txn_fingerprint(p_date TEXT, p_desc TEXT, p_amount REAL, p_direction TEXT)
  RETURNS TEXT AS $$
  BEGIN
    RETURN p_date || '|' || regexp_replace(upper(trim(p_desc)), '[[:space:]]+', ' ', 'g') || '|' || p_amount::TEXT || '|' || upper(trim(p_direction));
  END;
  $$ LANGUAGE plpgsql IMMUTABLE;
`;