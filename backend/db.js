import pg from 'pg';
import { log } from './utils/logger.js';

const { Pool } = pg;

export default class Database {
  constructor() {
    const connectionString = process.env.DATABASE_URL || 
      'postgresql://postgres:***@postgres:5432/railway';
    
    this.pool = new Pool({
      connectionString,
      ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
    });
    
    log('DATABASE', `Connecting to PostgreSQL...`);
    log('DATABASE', `Using host: ${process.env.DATABASE_URL ? 'DATABASE_URL env var' : 'postgres:5432'}`);
  }

  async init() {
    try {
      const result = await this.pool.query('SELECT NOW()');
      log('DATABASE', `✓ Connected to PostgreSQL: ${result.rows[0].now}`);
      await this.createTables();
      await this.migrateSchema();
      await this.seedData();
    } catch (err) {
      log('DATABASE', `❌ Connection failed: ${err.message}`);
      throw err;
    }
  }

  async createTables() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE,
        role TEXT DEFAULT 'admin'
      )`,
      
      `CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        date TEXT,
        description TEXT,
        category TEXT,
        amount REAL,
        direction TEXT,
        is_fixed BOOLEAN DEFAULT FALSE,
        balance REAL,
        source TEXT,
        user_id INTEGER REFERENCES users(id),
        category_corrected BOOLEAN DEFAULT FALSE,
        previous_category TEXT,
        correction_timestamp TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS credit_cards (
        id SERIAL PRIMARY KEY,
        name TEXT,
        balance REAL,
        "limit" REAL,
        apr REAL,
        user_id INTEGER REFERENCES users(id)
      )`,
      
      `CREATE TABLE IF NOT EXISTS savings_goals (
        id SERIAL PRIMARY KEY,
        name TEXT,
        target REAL,
        current REAL,
        deadline TEXT,
        user_id INTEGER REFERENCES users(id)
      )`,

      `CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE,
        icon TEXT,
        color TEXT
      )`
    ];

    try {
      for (const sql of statements) {
        await this.pool.query(sql);
      }
      log('DATABASE', '✓ All tables created/verified');
    } catch (err) {
      log('DATABASE', `❌ Error creating tables: ${err.message}`);
      throw err;
    }
  }

  async migrateSchema() {
    try {
      // Add new columns if they don't exist
      const migrations = [
        `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_corrected BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS previous_category TEXT`,
        `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_fixed BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS correction_timestamp TIMESTAMP`,
        `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_fixed BOOLEAN DEFAULT FALSE`
      ];

      for (const sql of migrations) {
        try {
          await this.pool.query(sql);
        } catch (err) {
          if (err.message.includes('already exists')) {
            // Column already exists, skip
          } else {
            throw err;
          }
        }
      }
      log('DATABASE', '✓ Schema migrations applied');
    } catch (err) {
      log('DATABASE', `❌ Error migrating schema: ${err.message}`);
      throw err;
    }
  }

  async seedData() {
    try {
      // Only seed categories (no mock transactions)
      const categoryCheck = await this.pool.query('SELECT COUNT(*) FROM categories');
      if (categoryCheck.rows[0].count > 0) {
        log('DATABASE', '✓ Categories already seeded, skipping');
        return;
      }

      // Insert comprehensive categories only
      const categories = [
        ['Groceries', '🛒', '#2ecc71'],
        ['Utilities', '⚡', '#3498db'],
        ['Gas', '⛽', '#e74c3c'],
        ['Dining', '🍽️', '#f39c12'],
        ['Shopping', '🛍️', '#9b59b6'],
        ['Entertainment', '🎬', '#e91e63'],
        ['Healthcare', '🏥', '#00bcd4'],
        ['Insurance', '🛡️', '#673ab7'],
        ['Subscriptions', '📺', '#ff9800'],
        ['Transportation', '🚗', '#795548'],
        ['Childcare', '👶', '#ffc0cb'],
        ['Education', '📚', '#4caf50'],
        ['Pet Care', '🐾', '#8bc34a'],
        ['Travel', '✈️', '#2196f3'],
        ['Gifts', '🎁', '#ff5722'],
        ['Home', '🏠', '#cddc39'],
        ['Maintenance', '🔧', '#9e9e9e'],
        ['Repairs', '🔨', '#607d8b'],
        ['Professional Services', '💼', '#3f51b5'],
        ['Taxes', '📋', '#1a237e'],
        ['Salary', '💵', '#1b5e20'],
        ['Bonus', '🎉', '#f57f17'],
        ['Investments', '📈', '#00695c'],
        ['Credit Card Payment', '💳', '#e91e63'],
        ['Credit Cards', '🗂️', '#ff6b6b'],
        ['Other', '📦', '#424242']
      ];

      for (const [name, icon, color] of categories) {
        await this.pool.query(
          'INSERT INTO categories (name, icon, color) VALUES ($1, $2, $3)',
          [name, icon, color]
        );
      }

      log('DATABASE', '✓ Categories seeded successfully (no mock transactions)');
    } catch (err) {
      log('DATABASE', `❌ Error seeding data: ${err.message}`);
      throw err;
    }
  }

  async all(sql, params = []) {
    try {
      const result = await this.pool.query(sql, params);
      return result.rows;
    } catch (err) {
      log('DATABASE', `❌ Query failed: ${err.message}`);
      throw err;
    }
  }

  async get(sql, params = []) {
    try {
      const result = await this.pool.query(sql, params);
      return result.rows[0];
    } catch (err) {
      log('DATABASE', `❌ Query failed: ${err.message}`);
      throw err;
    }
  }

  async run(sql, params = []) {
    try {
      await this.pool.query(sql, params);
    } catch (err) {
      log('DATABASE', `❌ Query failed: ${err.message}`);
      throw err;
    }
  }

  async importTransactions(transactions) {
    try {
      let imported = 0;
      let duplicates = 0;

      for (const txn of transactions) {
        try {
          // Check for duplicate
          const existing = await this.pool.query(
            'SELECT id FROM transactions WHERE date = $1 AND description = $2 AND amount = $3',
            [txn.date, txn.description, txn.amount]
          );

          if (existing.rows.length > 0) {
            duplicates++;
            continue;
          }

          // Insert transaction
          await this.pool.query(
            'INSERT INTO transactions (date, description, category, amount, direction, balance, source, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [txn.date, txn.description, txn.category, txn.amount, txn.direction, txn.balance || null, txn.source, 1]
          );

          imported++;
        } catch (err) {
          log('DATABASE', `Error importing transaction: ${err.message}`);
        }
      }

      log('DATABASE', `✓ Import complete: ${imported} imported, ${duplicates} duplicates skipped`);
      return { imported, duplicates };
    } catch (err) {
      log('DATABASE', `❌ Error importing transactions: ${err.message}`);
      throw err;
    }
  }

  async close() {
    await this.pool.end();
    log('DATABASE', '✓ Connection closed');
  }
}
