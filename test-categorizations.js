#!/usr/bin/env node

/**
 * Test script for Categorizations API endpoints
 * Tests all 5 endpoints to ensure they work correctly
 */

const API_BASE = 'http://localhost:3000/api/categorizations';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function test(name, fn) {
  try {
    log(`\n✓ Testing: ${name}`, 'blue');
    await fn();
    log(`  PASSED`, 'green');
  } catch (err) {
    log(`  FAILED: ${err.message}`, 'red');
    process.exit(1);
  }
}

async function main() {
  log('=== CATEGORIZATIONS API TEST SUITE ===\n', 'yellow');

  // Test 1: GET /api/categorizations/list
  await test('POST /list - Get transactions', async () => {
    const res = await fetch(`${API_BASE}/list?limit=10&offset=0&dateFilter=all`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.transactions) throw new Error('Missing transactions array');
    if (!data.counts) throw new Error('Missing counts object');
    log(`  → Fetched ${data.transactions.length} transactions`, 'green');
    log(`  → Counts: ${data.counts.uncategorized} uncategorized, ${data.counts.categorized} categorized`, 'green');
  });

  // Test 2: POST /api/categorizations/category-summary
  await test('POST /category-summary - Get category counts', async () => {
    const res = await fetch(`${API_BASE}/category-summary`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.categories)) throw new Error('Missing categories array');
    log(`  → Found ${data.categories.length} categories`, 'green');
  });

  // Test 3: POST /api/categorizations/patterns
  await test('POST /patterns - Get keyword patterns', async () => {
    const res = await fetch(`${API_BASE}/patterns`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.patterns)) throw new Error('Missing patterns array');
    log(`  → Found ${data.patterns.length} patterns`, 'green');
    if (data.patterns.length > 0) {
      log(`  → First pattern: "${data.patterns[0].keyword}" (${data.patterns[0].count} transactions)`, 'green');
    }
  });

  // Test 4: POST /api/categorizations/by-category
  await test('POST /by-category - Get transactions by category', async () => {
    const res = await fetch(`${API_BASE}/by-category`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'Groceries', limit: 10, offset: 0 })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.transactions)) throw new Error('Missing transactions array');
    log(`  → Found ${data.transactions.length} Groceries transactions`, 'green');
  });

  // Test 5: POST /api/categorizations/update-batch (with empty array - safe test)
  await test('POST /update-batch - Batch update categories', async () => {
    const res = await fetch(`${API_BASE}/update-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: [] })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.success !== true) throw new Error('Expected success: true');
    log(`  → Batch update endpoint working (tested with empty array)`, 'green');
  });

  // Test 6: POST /api/categorizations/learn-pattern (with test keyword - safe test)
  await test('POST /learn-pattern - Learn pattern', async () => {
    const res = await fetch(`${API_BASE}/learn-pattern`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: 'TEST_NONEXISTENT_KEYWORD_12345', suggestedCategory: 'Other' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.success !== true) throw new Error('Expected success: true');
    log(`  → Pattern learning endpoint working (updated ${data.updated} transactions)`, 'green');
  });

  log('\n=== ALL TESTS PASSED ===\n', 'green');
  process.exit(0);
}

main().catch(err => {
  log(`\nFATAL ERROR: ${err.message}`, 'red');
  process.exit(1);
});
