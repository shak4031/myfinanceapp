import { stripBankPrefix } from './normalize.js';

export const TENANT = "user_id = current_setting('app.user_id')::integer";
export const RULES_SQL = `SELECT l.id, l.pattern, l.display_label, l.match_type, l.enabled,
  l.priority, l.is_fixed, c.name AS category FROM transaction_labels l
  LEFT JOIN categories c ON c.id = l.category_id AND c.user_id = l.user_id
  WHERE l.${TENANT} ORDER BY l.priority DESC, length(l.pattern) DESC, l.id`;

export function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

// Literal merchant identity: strip bank boilerplate, never interpret punctuation as regex.
export function canonicalMerchant(description) {
  return stripBankPrefix(String(description ?? '')).replace(/\s+/g, ' ').trim().toUpperCase();
}

export function compileRules(rules) {
  return rules.filter(rule => rule.enabled !== false).map(rule => {
    if (typeof rule.pattern !== 'string' || !rule.pattern.trim() || rule.pattern.length > 256) {
      throw failure(422, `Invalid categorization rule ${rule.id}: pattern must contain 1-256 characters`);
    }
    let regex;
    if (rule.match_type !== 'merchant') {
      // Legacy expressions are deliberately restricted to bounded, non-grouped patterns.
      // Reject repetition/groups/backreferences rather than risk catastrophic backtracking.
      const alternatives = rule.pattern.split('|');
      if (/[(){}*+?]/.test(rule.pattern.replace(/\\s[*+]/g, '')) || /\\[1-9]/.test(rule.pattern)
        || alternatives.length > 32 || alternatives.some(part => (part.match(/\\s[*+]/g) || []).length > 1)) {
        throw failure(422, `Invalid legacy categorization rule ${rule.id}: replace with a literal merchant rule`);
      }
      try { regex = new RegExp(rule.pattern, 'i'); } catch {
        throw failure(422, `Invalid legacy categorization rule ${rule.id}: malformed regular expression`);
      }
    }
    return { ...rule, regex };
  }).sort((a, b) => Number(b.priority) - Number(a.priority)
    || b.pattern.length - a.pattern.length || Number(a.id) - Number(b.id));
}

const FALLBACKS = [
  [/\b(?:chargepoint|electrify america|evgo|tesla supercharger|blink charging)\b/i, 'EV Charging'],
  [/\b(?:shoprite|trader joe'?s?|whole foods|instacart|grocery)\b/i, 'Groceries'],
  [/\b(?:restaurant|starbucks|chipotle|doordash|grubhub|uber eats|pizza)\b/i, 'Dining'],
  [/\b(?:netflix|spotify|hulu|disney plus)\b/i, 'Subscriptions'],
  [/\b(?:pharmacy|walgreens|hospital|medical)\b/i, 'Healthcare'],
  [/\b(?:payroll|salary|paycheck)\b/i, 'Salary']
];

export function classify(transaction, rules, categories) {
  const description = String(transaction.description ?? '');
  const merchant = canonicalMerchant(description);
  const rule = rules.find(item => item.match_type === 'merchant'
    ? canonicalMerchant(item.pattern) === merchant
    : item.regex.test(description.slice(0, 2000)));
  if (rule) {
    if (rule.category && categories.has(rule.category)) {
      return { category: rule.category, ruleId: rule.id, label: rule, reason: `User rule: ${rule.display_label || rule.pattern}` };
    }
    // A fixed-only label may have no category; retain its explicit flag on new imports.
    return { ...fallback(transaction, categories), ruleId: rule.id, label: rule };
  }
  return fallback(transaction, categories);
}

function fallback(transaction, categories) {
  const match = FALLBACKS.find(([pattern, category]) =>
    categories.has(category) && pattern.test(String(transaction.description ?? ''))
    && (category !== 'Salary' || String(transaction.direction).toUpperCase() === 'CREDIT'));
  return { category: match?.[1] ?? (categories.has('Other') ? 'Other' : null),
    ruleId: null, label: null, reason: match ? `Built-in merchant match: ${match[1]}` : 'No confident merchant match' };
}

export function preview(transactions, rules, categories, scope) {
  if (!['all', 'uncategorized'].includes(scope)) throw failure(400, 'scope must be uncategorized or all');
  const suggestions = [];
  for (const transaction of transactions) {
    if (transaction.category_corrected || (scope === 'uncategorized'
      && transaction.category && !['Other', 'Uncategorized'].includes(transaction.category))) continue;
    const suggestion = classify(transaction, rules, categories);
    if (!suggestion.category || suggestion.category === transaction.category) continue;
    suggestions.push({ id: transaction.id, description: transaction.description,
      currentCategory: transaction.category ?? null, suggestedCategory: suggestion.category,
      reason: suggestion.reason, ruleId: suggestion.ruleId });
  }
  return { suggestions, unchanged: transactions.length - suggestions.length };
}

export async function loadCategorization(client) {
  const rules = (await client.query(RULES_SQL)).rows;
  const categories = (await client.query(`SELECT id, name FROM categories WHERE ${TENANT} ORDER BY name`)).rows;
  return { rules, categories, compiled: compileRules(rules), names: new Set(categories.map(row => row.name)) };
}

export async function saveRule(client, input, id) {
  if (!input || typeof input.pattern !== 'string' || !input.pattern.trim() || input.pattern.length > 256
    || typeof input.category !== 'string' || !Number.isInteger(input.priority) || input.priority < 0 || input.priority > 1000
    || typeof input.enabled !== 'boolean'
    || (input.display_label !== undefined && (typeof input.display_label !== 'string' || input.display_label.length > 256))) {
    throw failure(400, 'Rule requires literal pattern (1-256 characters), category, integer priority (0-1000), and boolean enabled');
  }
  const category = (await client.query(`SELECT id FROM categories WHERE name = $1 AND ${TENANT}`, [input.category])).rows[0];
  if (!category) throw failure(400, 'Unknown category');
  if (!canonicalMerchant(input.pattern)) throw failure(400, 'Merchant pattern must not be empty');
  const params = [canonicalMerchant(input.pattern), input.display_label?.trim() || input.pattern.trim(), category.id, input.priority, input.enabled];
  const result = id == null
    ? await client.query(`INSERT INTO transaction_labels (pattern, display_label, category_id, priority, enabled, match_type)
        VALUES ($1,$2,$3,$4,$5,'merchant')
        ON CONFLICT (user_id, pattern) DO UPDATE SET display_label = EXCLUDED.display_label,
        category_id = EXCLUDED.category_id, priority = EXCLUDED.priority, enabled = EXCLUDED.enabled, match_type = 'merchant'
        RETURNING id, pattern, display_label, priority, enabled`, params)
    : await client.query(`UPDATE transaction_labels SET pattern=$1, display_label=$2, category_id=$3,
        priority=$4, enabled=$5, match_type='merchant' WHERE id=$6 AND ${TENANT}
        RETURNING id, pattern, display_label, priority, enabled`, [...params, id]);
  if (!result.rows[0]) throw failure(404, 'Rule not found');
  return { ...result.rows[0], category: input.category };
}

export async function applyUpdates(db, updates, { expected = true, protectCorrections = true } = {}) {
  if (!Array.isArray(updates) || updates.length > 5000) throw failure(400, 'updates must be an array of at most 5000 items');
  const ids = new Set();
  for (const item of updates) {
    if (!item || !Number.isSafeInteger(Number(item.id)) || Number(item.id) < 1 || ids.has(Number(item.id))
      || typeof item.category !== 'string' || (expected && !Object.hasOwn(item, 'expectedCategory'))
      || (expected && item.expectedCategory !== null && typeof item.expectedCategory !== 'string')) {
      throw failure(400, 'Each update requires a unique id, category, and expectedCategory');
    }
    ids.add(Number(item.id));
  }
  return db.transaction(async client => {
    const categories = new Set((await client.query(`SELECT name FROM categories WHERE ${TENANT}`)).rows.map(row => row.name));
    const rows = (await client.query(`SELECT id, category, category_corrected FROM transactions
      WHERE id = ANY($1::integer[]) AND ${TENANT} ORDER BY id FOR UPDATE`, [[...ids]])).rows;
    const byId = new Map(rows.map(row => [Number(row.id), row]));
    for (const item of updates) {
      const row = byId.get(Number(item.id));
      if (!row) throw failure(404, 'Transaction not found');
      if (!categories.has(item.category)) throw failure(400, 'Unknown category');
      if ((expected && (row.category ?? null) !== item.expectedCategory)
        || (protectCorrections && row.category_corrected)) {
        throw failure(409, `Transaction ${item.id} changed or has a manual correction; refresh the preview`);
      }
    }
    let updated = 0;
    for (const item of updates) {
      if (byId.get(Number(item.id)).category === item.category) continue;
      await client.query(`UPDATE transactions SET previous_category=category, category=$1,
        category_corrected=TRUE, correction_timestamp=NOW() WHERE id=$2 AND ${TENANT}`, [item.category, item.id]);
      updated++;
    }
    return { updated };
  });
}
