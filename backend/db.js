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
      
      `CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE,
        icon TEXT,
        color TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS transaction_labels (
        id SERIAL PRIMARY KEY,
        pattern TEXT UNIQUE,
        display_label TEXT,
        category_id INTEGER REFERENCES categories(id),
        is_fixed BOOLEAN DEFAULT FALSE,
        is_excluded BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        date TEXT,
        description TEXT,
        label_id INTEGER REFERENCES transaction_labels(id),
        amount REAL,
        direction TEXT,
        balance REAL,
        source TEXT,
        user_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      `CREATE TABLE IF NOT EXISTS staging_transactions (
        id SERIAL PRIMARY KEY,
        date TEXT,
        description TEXT,
        amount REAL,
        direction TEXT,
        balance REAL,
        source TEXT,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      // Add new columns to existing schema
      const migrations = [
        `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS label_id INTEGER REFERENCES transaction_labels(id)`
      ];

      for (const sql of migrations) {
        try {
          await this.pool.query(sql);
        } catch (err) {
          // ignore already exists
        }
      }
      log('DATABASE', '✓ Schema migrations applied');
    } catch (err) {
      log('DATABASE', `❌ Migration error: ${err.message}`);
    }
  }

  async processStaging() {
    try {
      log('DATABASE', 'Processing staging transactions...');
      
      const pending = await this.all("SELECT * FROM staging_transactions WHERE status = 'pending'");
      
      for (const st of pending) {
        try {
          // 1. Identify label (exact match or pattern)
          const labels = await this.all("SELECT * FROM transaction_labels");
          let labelId = null;
          
          for (const l of labels) {
            const regex = new RegExp(l.pattern, 'i');
            if (regex.test(st.description)) {
              if (l.is_excluded) {
                await this.run("UPDATE staging_transactions SET status = 'excluded' WHERE id = $1", [st.id]);
                continue;
              }
              labelId = l.id;
              break;
            }
          }

          // 2. Insert into main table
          await this.run(
            `INSERT INTO transactions (date, description, label_id, amount, direction, balance, source, user_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
            [st.date, st.description, labelId, st.amount, st.direction, st.balance, st.source]
          );

          await this.run("UPDATE staging_transactions SET status = 'processed' WHERE id = $1", [st.id]);
        } catch (err) {
          await this.run("UPDATE staging_transactions SET status = 'error', error_message = $1 WHERE id = $2", [err.message, st.id]);
        }
      }
    } catch (err) {
      log('DATABASE', `❌ Error processing staging: ${err.message}`);
    }
  }

  async seedData() {
    try {
      // 1. Seed Categories
      const categoryCheck = await this.pool.query('SELECT COUNT(*) FROM categories');
      if (categoryCheck.rows[0].count === '0') {
        const categories = [
          ['Groceries', '🛒', '#2ecc71'], ['Utilities', '⚡', '#3498db'], ['Gas', '⛽', '#e74c3c'],
          ['Dining', '🍽️', '#f39c12'], ['Shopping', '🛍️', '#9b59b6'], ['Entertainment', '🎬', '#e91e63'],
          ['Healthcare', '🏥', '#00bcd4'], ['Insurance', '🛡️', '#673ab7'], ['Subscriptions', '📺', '#ff9800'],
          ['Transportation', '🚗', '#795548'], ['Home', '🏠', '#cddc39'], ['Salary', '💵', '#1b5e20'],
          ['Credit Cards', '🗂️', '#ff6b6b'], ['Car Loans', '🏎️', '#e74c3c'], ['Internet', '🌐', '#3498db'], 
          ['Other', '📦', '#424242']
        ];
        for (const [name, icon, color] of categories) {
          await this.pool.query('INSERT INTO categories (name, icon, color) VALUES ($1, $2, $3)', [name, icon, color]);
        }
        log('DATABASE', '✓ Categories seeded');
      }

      // 2. Seed Transaction Labels (The "Normalization" Source of Truth)
      const labelCheck = await this.pool.query('SELECT COUNT(*) FROM transaction_labels');
      if (labelCheck.rows[0].count === '0') {
        const labels = [
          { pattern: 'HYUNDAI', label: 'Hyundai Lease (Car)', cat: 'Car Loans', fixed: true },
          { pattern: 'SANTANDER', label: 'Santander Auto (Loan)', cat: 'Car Loans', fixed: true },
          { pattern: 'OLLO', label: 'Ollo Credit Card', cat: 'Credit Cards', fixed: true },
          { pattern: 'PSEG', label: 'PSEG (Utilities)', cat: 'Utilities', fixed: true },
          { pattern: 'VERIZON', label: 'Verizon (Internet)', cat: 'Internet', fixed: true },
          { pattern: 'COMCAST', label: 'Comcast (Internet)', cat: 'Internet', fixed: true },
          { pattern: 'NETFLIX', label: 'Netflix', cat: 'Subscriptions', fixed: false }
        ];

        for (const l of labels) {
          const cat = await this.get("SELECT id FROM categories WHERE name = $1", [l.cat]);
          if (cat) {
            await this.pool.query(
              'INSERT INTO transaction_labels (pattern, display_label, category_id, is_fixed) VALUES ($1, $2, $3, $4)',
              [l.pattern, l.label, cat.id, l.fixed]
            );
          }
        }
        log('DATABASE', '✓ Transaction labels seeded');
      }
    } catch (err) {
      log('DATABASE', `❌ Error seeding data: ${err.message}`);
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
