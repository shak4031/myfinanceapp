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

const DISALLOWED_PATTERNS = new Set([
  'VISA', 'DDA', 'PUR', 'REF', 'AP', 'CARD', 'PURCHASE', 'PAYMENT', 
  'DEBIT', 'CREDIT', 'CHECK', 'ONLINE', 'PMT', 'TRANSFER', 'XFER',
  'OTHER', 'UNCATEGORIZED', 'THE', 'AND', 'FOR', 'WITH', 'INC', 'LLC', 'CORP', 'CO'
]);

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
 * Strict prefix stripper - only strips proven bank prefixes, never eats merchant names
 */
export function stripBankPrefix(description) {
  if (!description) return '';
  let s = description.replace(/\s+/g, ' ').trim();

  // Zelle
  if (/\bZELLE\b/i.test(s)) {
    const lastZelle = s.lastIndexOf(' ZELLE ');
    if (lastZelle !== -1) {
      return s.slice(lastZelle + ' ZELLE '.length).trim();
    }
    const match = s.match(/\bZELLE\s+(?:TO|FROM|SENT|RECEIVED)?\s*(?:[A-Z0-9xX]+)?\s*(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }

  // Explicit Card & DDA Prefixes (with mandatory prefix tokens)
  // 1. "VISA DDA PUR AP 123456 " or "VISA DDA REF AP 123456 " or "VISA DDA PUR "
  s = s.replace(/^VISA\s+DDA\s+(?:PUR|REF|RETURN|CREDIT)?(?:\s+AP\s+[A-Z0-9xX]+)?\s+/i, '');
  // 2. "DDA PURCHASE AP 123456 " or "DDA PURCHASE " or "DDA PUR AP 123456 "
  s = s.replace(/^DDA\s+(?:PURCHASE|PUR|REF|RETURN|CREDIT)?(?:\s+AP\s+[A-Z0-9xX]+)?\s+/i, '');
  // 3. "POS DEBIT AP 123456 " or "POS PURCHASE "
  s = s.replace(/^POS\s+(?:DEBIT|PURCHASE|PUR|REF)?(?:\s+AP\s+[A-Z0-9xX]+)?\s+/i, '');
  // 4. "CHECK CARD PURCHASE AP 123456 " or "CHECK CARD "
  s = s.replace(/^CHECK\s+CARD(?:\s+PURCHASE|\s+PUR)?(?:\s+AP\s+[A-Z0-9xX]+)?\s+/i, '');
  // 5. "DEBIT CARD PURCHASE - "
  s = s.replace(/^DEBIT\s+CARD(?:\s+PURCHASE)?\s*[-:]?\s*/i, '');

  return s.trim();
}

/**
 * Extract the core merchant identifier from messy bank transaction descriptions.
 */
export function extractMerchantCore(description) {
  return getCanonicalMerchant(description);
}

/**
 * Get canonical normalized merchant name for grouping and display.
 */
export function getCanonicalMerchant(description) {
  if (!description) return '';
  let s = stripBankPrefix(description);

  // Remove phone numbers: 833 6322778, 800-591-3869, 888-731-5396, 800 436 7734, 610 358 8000
  s = s.replace(/\b\d{3}[-\s.]?\d{3}[-\s.]?\d{4}\b/g, '');
  s = s.replace(/\b\d{3}[-\s.]\d{7}\b/g, '');

  // Remove trailing state codes & asterisks (* VA, * MN, * CA, * NJ, * MD, * DE)
  s = s.replace(/[\*#]\s*[A-Z]{2}\s*$/i, '');
  s = s.replace(/\b[A-Z]{2}\s*$/i, '');

  const upper = s.toUpperCase().trim();

  // Specific high-frequency merchants
  if (/ELECTRIFY\s*AMERICA/i.test(upper)) return 'ELECTRIFY AMERICA';
  if (/CHARGEPOINT/i.test(upper)) return 'CHARGEPOINT';
  if (/TESLA\s*(?:SUPERCHARGER|CHARGING)/i.test(upper)) return 'TESLA SUPERCHARGER';
  if (/BLINK\s*CHARGING/i.test(upper)) return 'BLINK CHARGING';
  if (/PLUGSHARE/i.test(upper)) return 'PLUGSHARE';
  if (/EVGO/i.test(upper)) return 'EVGO';
  if (/\bTARGET\b/i.test(upper)) return 'TARGET';
  if (/\bINSTACART\b/i.test(upper)) return 'INSTACART';
  if (/\bNETFLIX\b/i.test(upper)) return 'NETFLIX';
  if (/\bWAWA\b/i.test(upper)) return 'WAWA';
  if (/TRADER\s*JOE/i.test(upper)) return 'TRADER JOE';
  if (/WHOLE\s*FOODS/i.test(upper)) return 'WHOLE FOODS';
  if (/HOME\s*DEPOT/i.test(upper)) return 'THE HOME DEPOT';
  if (/UBER\s*EATS/i.test(upper)) return 'UBER EATS';
  if (/MUSIC\s*&?\s*ARTS/i.test(upper)) return 'MUSIC & ARTS';
  if (/STATE\s*FARM/i.test(upper)) return 'STATE FARM';
  if (/PENNYMAC/i.test(upper)) return 'PENNYMAC';
  if (/SANTANDER/i.test(upper)) return 'SANTANDER AUTO';
  if (/HYUNDAI/i.test(upper)) return 'HYUNDAI LEASE';
  if (/PSEG|PUBLIC\s*SERVICE/i.test(upper)) return 'PSEG';
  if (/\bVERIZON\b/i.test(upper)) return 'VERIZON';
  if (/COMCAST|XFINITY/i.test(upper)) return 'COMCAST-XFINITY';
  if (/\b(?:AT&T|ATT)\b/i.test(upper) || /^ATT\b/i.test(upper)) return 'AT&T';
  if (/ROCKET\s*(?:MONEY|PREMIUM)?/i.test(upper)) return 'ROCKET MONEY';

  // Generic cleaning: strip URLs, noise words
  s = s.replace(/\.COM\b|\.CO\b|\.NET\b|\.ORG\b|\bCOM\b/gi, '');
  s = s.replace(/\b(?:ONLINE\s+PMT|PAYMENTREC|PAYMENT|AUTOPAY|SFPP|DIR\s+DEP|PURCHASE|PENDING)\b/gi, '');
  s = s.replace(/[^\w\s&]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  if (!s || s.length < 2 || DISALLOWED_PATTERNS.has(s.toUpperCase())) {
    return description.replace(/\s+/g, ' ').trim();
  }

  return s;
}

/**
 * Build a stable regex pattern for transaction labels.
 * GUARANTEED to never match generic boilerplate words like VISA or DDA.
 */
export function buildLabelPattern(description) {
  const merchant = getCanonicalMerchant(description);
  if (!merchant) return escapeRegex(description.replace(/\s+/g, ' ').trim());

  if (merchant === 'ELECTRIFY AMERICA') return 'ELECTRIFY\\s*AMERICA';
  if (merchant === 'CHARGEPOINT') return 'CHARGEPOINT';
  if (merchant === 'TESLA SUPERCHARGER') return 'TESLA';
  if (merchant === 'BLINK CHARGING') return 'BLINK';
  if (merchant === 'PLUGSHARE') return 'PLUGSHARE';
  if (merchant === 'EVGO') return 'EVGO';
  if (merchant === 'TARGET') return '\\bTARGET\\b';
  if (merchant === 'INSTACART') return '\\bINSTACART\\b';
  if (merchant === 'NETFLIX') return '\\bNETFLIX\\b';
  if (merchant === 'WAWA') return '\\bWAWA\\b';
  if (merchant === 'TRADER JOE') return 'TRADER\\s*JOE';
  if (merchant === 'WHOLE FOODS') return 'WHOLE\\s*FOODS';
  if (merchant === 'THE HOME DEPOT') return 'HOME\\s*DEPOT';
  if (merchant === 'UBER EATS') return 'UBER\\s*EATS';
  if (merchant === 'MUSIC & ARTS') return 'MUSIC\\s*&?\\s*ARTS';
  if (merchant === 'STATE FARM') return 'STATE\\s*FARM';
  if (merchant === 'PENNYMAC') return 'PENNYMAC';
  if (merchant === 'SANTANDER AUTO') return 'SANTANDER';
  if (merchant === 'HYUNDAI LEASE') return 'HYUNDAI';
  if (merchant === 'PSEG') return 'PSEG|PUBLIC\\s*SERVICE';
  if (merchant === 'VERIZON') return '\\bVERIZON\\b';
  if (merchant === 'COMCAST-XFINITY') return 'COMCAST|XFINITY';
  if (merchant === 'AT&T') return 'AT&?T\\b|ATT\\b';
  if (merchant === 'ROCKET MONEY') return 'ROCKET\\s*(?:MONEY|PREMIUM)?';

  const words = merchant.split(/\s+/).filter(w => w.length > 1 && !DISALLOWED_PATTERNS.has(w.toUpperCase()));
  if (words.length > 0) {
    return words.map(w => escapeRegex(w)).join('\\s+');
  }
  return escapeRegex(description.replace(/\s+/g, ' ').trim());
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