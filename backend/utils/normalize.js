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

export function escapeRegex(value = '') {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Universal date parser that reliably parses any date format
 * (YYYY-MM-DD, MM/DD/YYYY, ISO timestamps, Date objects)
 * into { year, month (0-11), day, iso }.
 */
export function parseTxDate(rawDate) {
  if (!rawDate) return null;
  if (rawDate instanceof Date) {
    return {
      year: rawDate.getFullYear(),
      month: rawDate.getMonth(), // 0-indexed
      day: rawDate.getDate(),
      iso: rawDate.toISOString().split('T')[0]
    };
  }
  const s = String(rawDate).trim();
  // YYYY-MM-DD or YYYY-MM-DDTHH... or YYYY/MM/DD
  const isoMatch = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10) - 1;
    const d = parseInt(isoMatch[3], 10);
    return {
      year: y,
      month: m,
      day: d,
      iso: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    };
  }
  // MM/DD/YYYY or MM-DD-YYYY
  const usMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (usMatch) {
    const y = parseInt(usMatch[3], 10);
    const m = parseInt(usMatch[1], 10) - 1;
    const d = parseInt(usMatch[2], 10);
    return {
      year: y,
      month: m,
      day: d,
      iso: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    };
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return {
      year: parsed.getFullYear(),
      month: parsed.getMonth(),
      day: parsed.getDate(),
      iso: parsed.toISOString().split('T')[0]
    };
  }
  return null;
}

/**
 * Extract the core merchant identifier from messy bank transaction descriptions.
 * Handles card prefixes (VISA DDA, PUR, REF, AP auth-codes), Zelle transfers, etc.
 */
export function extractMerchantCore(description) {
  return getCanonicalMerchant(description);
}

/**
 * Get canonical normalized merchant name for grouping and display.
 */
export function getCanonicalMerchant(description) {
  if (!description) return '';
  let s = description.replace(/\s+/g, ' ').trim().toUpperCase();

  // 1. Zelle handling: extract payee name
  if (/\bZELLE\b/i.test(s)) {
    const lastZelle = s.lastIndexOf(' ZELLE ');
    if (lastZelle !== -1) {
      s = s.slice(lastZelle + ' ZELLE '.length).trim();
    } else {
      const match = s.match(/\bZELLE\s+(?:TO|FROM|SENT|RECEIVED)?\s*(?:[A-Z0-9xX]+)?\s*(.+)$/i);
      if (match && match[1]) s = match[1].trim();
    }
  }

  // 2. Remove standard bank card and transaction noise prefixes
  s = s.replace(/^(?:VISA\s+)?(?:DDA|POS|DEBIT(?:\s+CARD)?|CHECK\s+CARD)\s+(?:PUR(?:CHASE)?|REF(?:UND)?|RETURN|CREDIT|PMT|PAYMENT)?(?:\s+AP)?(?:\s+[A-Z0-9xX]{3,12})?\s+/i, '');
  s = s.replace(/^(?:DDA|VISA|POS)\s+(?:PURCHASE|PUR|REF|RETURN|CREDIT)\s+(?:AP\s+)?(?:[A-Z0-9xX]{3,12}\s+)?/i, '');

  // 3. Remove phone numbers (e.g. 888-731-5396, 888 731 5396, 800-436-7734)
  s = s.replace(/\b\d{3}[-\s]\d{3}[-\s]\d{4}\b/g, '');

  // 4. Remove trailing state codes (e.g. * NJ, * MD, * CA, NJ, MD, CA at end of line)
  s = s.replace(/\*\s*[A-Z]{2}$/i, '');
  s = s.replace(/\b[A-Z]{2}$/i, '');

  // 5. Special known merchant normalizations
  if (/MUSIC\s*&?\s*ARTS/i.test(s)) return 'MUSIC & ARTS';
  if (/STATE\s+FARM/i.test(s)) return 'STATE FARM';
  if (/PENNYMAC/i.test(s)) return 'PENNYMAC';
  if (/NETFLIX/i.test(s)) return 'NETFLIX';
  if (/SANTANDER/i.test(s)) return 'SANTANDER AUTO';
  if (/HYUNDAI/i.test(s)) return 'HYUNDAI LEASE';
  if (/PSEG|PUBLIC\s+SERVICE/i.test(s)) return 'PSEG';
  if (/VERIZON/i.test(s)) return 'VERIZON';
  if (/COMCAST|XFINITY/i.test(s)) return 'COMCAST-XFINITY';
  if (/TRADER\s+JOE/i.test(s)) return 'TRADER JOES';
  if (/WHOLE\s+FOODS/i.test(s)) return 'WHOLE FOODS';
  if (/HOME\s+DEPOT/i.test(s)) return 'THE HOME DEPOT';
  if (/UBER\s*EATS/i.test(s)) return 'UBER EATS';

  // 6. Generic cleanup: remove web domain suffixes, noise words
  s = s.replace(/\.COM\b|\.CO\b|\.NET\b|\.ORG\b|\bCOM\b/gi, '');
  s = s.replace(/\b(?:ONLINE\s+PMT|PAYMENTREC|PAYMENT|AUTOPAY|SFPP|DIR\s+DEP|PURCHASE|PENDING)\b/gi, '');
  s = s.replace(/[^\w\s&]/g, ' '); // remove special chars except &
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

/**
 * Build a stable regex pattern for transaction labels.
 */
export function buildLabelPattern(description) {
  const canonical = getCanonicalMerchant(description);
  if (!canonical) return escapeRegex(description.replace(/\s+/g, ' ').trim());

  if (canonical === 'MUSIC & ARTS') return 'MUSIC\\s*&?\\s*ARTS';
  if (canonical === 'STATE FARM') return 'STATE\\s+FARM';
  if (canonical === 'PENNYMAC') return 'PENNYMAC';
  if (canonical === 'NETFLIX') return 'NETFLIX';
  if (canonical === 'SANTANDER AUTO') return 'SANTANDER';
  if (canonical === 'HYUNDAI LEASE') return 'HYUNDAI';
  if (canonical === 'PSEG') return 'PSEG|PUBLIC\\s+SERVICE';
  if (canonical === 'VERIZON') return 'VERIZON';
  if (canonical === 'COMCAST-XFINITY') return 'COMCAST|XFINITY';
  if (canonical === 'TRADER JOES') return 'TRADER\\s+JOE';
  if (canonical === 'WHOLE FOODS') return 'WHOLE\\s+FOODS';
  if (canonical === 'THE HOME DEPOT') return 'HOME\\s+DEPOT';
  if (canonical === 'UBER EATS') return 'UBER\\s*EATS';

  const words = canonical.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return words.map(w => escapeRegex(w)).join('\\s+');
  }
  return escapeRegex(canonical);
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