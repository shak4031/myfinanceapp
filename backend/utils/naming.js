import { TENANT, failure } from './categorization.js';

// User rename rules: "transactions containing these words show as <name>".
// The bank description is never changed (transfer and income detection rely on it); the friendly name is
// stored in transactions.display_name and used wherever a merchant or payee is shown or grouped.
export const NAME_MAX = 80;
export const PATTERN_MAX = 256;
// Statement boilerplate that often starts a description. Dropped from suggested patterns only.
const LEADING_NOISE = new Set('SENT RECEIVED TO FROM VISA DDA PUR POS DEBIT CREDIT CHECK CARD CHECKCARD PURCHASE AP REF ACH PMT PAYMENT ONLINE RECURRING WEB MOBILE ELECTRONIC'.split(' '));

// Words compared case-insensitively; anything containing a digit is a reference number, date or store id, so it is
// ignored on both sides. "SENT 626800I0ARPL Zelle CRISTIANE DE LIMA" -> "SENT ZELLE CRISTIANE DE LIMA".
export function nameWords(text) {
  return String(text ?? '').toUpperCase().split(/[^A-Z0-9&']+/)
    .map(word => word.replace(/^'+|'+$/g, '')).filter(word => word && !/\d/.test(word));
}
export const nameKey = text => nameWords(text).join(' ');

export function suggestNamePattern(description) {
  const words = nameWords(description);
  let start = 0;
  while (start < words.length - 1 && LEADING_NOISE.has(words[start])) start++;
  if (['TST', 'TOAST', 'SQ', 'SQUARE'].includes(words[start])) {
    while (['TST', 'TOAST', 'SQ', 'SQUARE'].includes(words[start])) start++;
    return words.slice(start, start + 3).join(' ');
  }
  return words.slice(start).join(' ');
}

// Longest (most specific) pattern wins, then the newest rule.
export function compileNameRules(rules) {
  return rules.map(rule => ({ ...rule, key: nameKey(rule.pattern) })).filter(rule => rule.key)
    .sort((a, b) => b.key.length - a.key.length || Number(b.id) - Number(a.id));
}
export const matchesName = (description, key) => !!key && ` ${nameKey(description)} `.includes(` ${key} `);
export const resolveName = (description, compiled) => compiled.find(rule => matchesName(description, rule.key)) || null;

export function validateNameRule(input) {
  const pattern = nameKey(input?.pattern);
  const name = typeof input?.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
  if (!pattern || pattern.length > PATTERN_MAX) throw failure(400, 'Enter the words to match (letters, at most 256 characters; numbers are ignored)');
  if (!name || name.length > NAME_MAX) throw failure(400, `Enter a name of 1-${NAME_MAX} characters`);
  return { pattern, name };
}

export const loadNameRules = async client =>
  (await client.query(`SELECT id,pattern,name FROM name_rules WHERE ${TENANT} ORDER BY id`)).rows;

// Recompute rule-derived names, preserving explicit per-payment selections.
export async function applyNameRules(client) {
  const compiled = compileNameRules(await loadNameRules(client));
  const rows = (await client.query(`SELECT id,description,display_name FROM transactions WHERE ${TENANT} AND NOT name_override`)).rows;
  const ids = [], names = [];
  for (const row of rows) {
    const name = resolveName(row.description, compiled)?.name ?? null;
    if ((row.display_name ?? null) !== name) { ids.push(row.id); names.push(name); }
  }
  if (ids.length) {
    await client.query(`UPDATE transactions t SET display_name=v.name FROM unnest($1::integer[], $2::text[]) AS v(id, name)
      WHERE t.id=v.id AND t.${TENANT}`, [ids, names]);
  }
  return ids.length;
}

export async function previewNameRule(client, input) {
  const pattern = nameKey(input?.pattern);
  if (!pattern) return { pattern, count: 0, samples: [] };
  const rows = (await client.query(`SELECT id,date,description,amount,direction,display_name FROM transactions WHERE ${TENANT} ORDER BY date DESC, id DESC`)).rows;
  const matched = rows.filter(row => matchesName(row.description, pattern));
  return { pattern, count: matched.length, transactions: matched, samples: [...new Set(matched.map(row => String(row.description).replace(/\s+/g, ' ').trim()))].slice(0, 5) };
}

// Rules with how many transactions each one currently names (a more specific rule takes precedence).
export async function listNameRules(client) {
  const rules = await loadNameRules(client);
  const compiled = compileNameRules(rules);
  const counts = new Map();
  for (const row of (await client.query(`SELECT description,display_name FROM transactions WHERE ${TENANT}`)).rows) {
    const rule = resolveName(row.description, compiled);
    if (rule && row.display_name === rule.name) counts.set(rule.id, (counts.get(rule.id) || 0) + 1);
  }
  return rules.map(rule => ({ ...rule, matches: counts.get(rule.id) || 0 }));
}

export async function currentNameRule(client, description) {
  const rule = resolveName(description, compileNameRules(await loadNameRules(client)));
  return rule ? { id: rule.id, pattern: rule.pattern, name: rule.name } : null;
}
