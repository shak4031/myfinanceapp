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
      `CREATE TABLE IF NOT EXISTS credit_cards (
        id SERIAL PRIMARY KEY,
        name TEXT,
        balance REAL,
        apr REAL,
        credit_limit REAL,
        min_payment REAL,
        due_date TEXT,
        user_id INTEGER REFERENCES users(id)
      )`,

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
      )`,

      `CREATE TABLE IF NOT EXISTS credit_cards (
        id SERIAL PRIMARY KEY,
        name TEXT,
        balance REAL,
        apr REAL,
        credit_limit REAL,
        min_payment REAL,
        due_date TEXT,
        user_id INTEGER REFERENCES users(id)
      )`,

      `CREATE TABLE IF NOT EXISTS savings_goals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        name TEXT NOT NULL,
        target_amount REAL NOT NULL DEFAULT 0,
        current_amount REAL NOT NULL DEFAULT 0,
        target_date TEXT,
        priority INTEGER DEFAULT 1,
        icon TEXT DEFAULT '\u{1f3af}',
        color TEXT DEFAULT '#4a9eff',
        notes TEXT,
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

  async dropOldDebtTable() {
    try {
      // If the old table exists with wrong columns, we need to fix it.
      // A cleaner way for a small app is to drop and re-seed if it's the 'fake' one.
      await this.run('DROP TABLE IF EXISTS credit_cards CASCADE');
      log('DATABASE', '⚠️ Dropped old credit_cards table for schema update');
    } catch (err) {
      log('DATABASE', `❌ Error dropping table: ${err.message}`);
    }
  }

  async migrateSchema() {
    try {
      // Add new columns to existing schema
      const migrations = [
        `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS label_id INTEGER REFERENCES transaction_labels(id)`
      ];
 
       // Ensure savings_goals columns exist (for tables created before this schema)
       const savingsGoalsMigrations = [
         `ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS user_id INTEGER`,
         `ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS name TEXT`,
         `ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS target_amount REAL`,
         `ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS current_amount REAL`,
         `ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS target_date TEXT`,
         `ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 1`,
         `ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT '🎯'`,
         `ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#4a9eff'`,
         `ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS notes TEXT`,
         `ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
       ];

      for (const sql of migrations) {
        try {
          await this.pool.query(sql);
        } catch (err) {
          // ignore already exists
        }
      }
      for (const sql of savingsGoalsMigrations) {
        try { await this.pool.query(sql); } catch (e) { /* ignore */ }
      }
      // Rename old savings_goals columns if they exist (prior schema used target/current/deadline)
      try {
        await this.pool.query(`
          DO $$
          BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'savings_goals' AND column_name = 'target')
              THEN ALTER TABLE savings_goals RENAME COLUMN target TO target_amount;
            END IF;
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'savings_goals' AND column_name = 'current')
              THEN ALTER TABLE savings_goals RENAME COLUMN current TO current_amount;
            END IF;
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'savings_goals' AND column_name = 'deadline')
              THEN ALTER TABLE savings_goals RENAME COLUMN deadline TO target_date;
            END IF;
          END $$;
        `);
      } catch (e) {}
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
          ['Groceries', '🛒', '#2ecc71'], ['Utilities', '⚡', '#3498db'], ['EV Charging', '🔌', '#00bcd4'], ['Gas', '⛽', '#e74c3c'],
          ['Dining', '🍽️', '#f39c12'], ['Shopping', '🛍️', '#9b59b6'], ['Entertainment', '🎬', '#e91e63'],
          ['Healthcare', '🏥', '#00bcd4'], ['Insurance', '🛡️', '#673ab7'], ['Subscriptions', '📺', '#ff9800'],
          ['Transportation', '🚗', '#795548'], ['Home', '🏠', '#cddc39'], ['Salary', '💵', '#1b5e20'],
          ['Mortgage', '🏡', '#cddc39'],
          ['Savings', '🐱', '#2ecc71'],
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
          { pattern: 'PENNYMAC', label: 'PennyMac Mortgage', cat: 'Mortgage', fixed: true },
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

      // Proactively ensure 'Mortgage' category is in database (if categories were seeded on a previous run)
      await this.run("INSERT INTO categories (name, icon, color) VALUES ('Mortgage', '🏡', '#cddc39') ON CONFLICT (name) DO NOTHING");
      await this.run(
        "INSERT INTO transaction_labels (pattern, display_label, category_id, is_fixed) VALUES ('PENNYMAC', 'PennyMac Mortgage', (SELECT id FROM categories WHERE name = 'Mortgage'), TRUE) ON CONFLICT (pattern) DO NOTHING"
      );

      // Proactively ensure 'Savings' category is in database (if categories were seeded on a previous run)
      await this.run("INSERT INTO categories (name, icon, color) VALUES ('Savings', '🐱', '#2ecc71') ON CONFLICT (name) DO NOTHING");
      await this.run("UPDATE categories SET icon = '🐱' WHERE name = 'Savings'");
      
      // Map any transfers explicitly marked as savings like Ally or Zelle Farin as savings 
      await this.run(
        "INSERT INTO transaction_labels (pattern, display_label, category_id, is_fixed) VALUES ('ALLY CC MOBILE PAY', 'Ally Savings Transfer', (SELECT id FROM categories WHERE name = 'Savings'), TRUE) ON CONFLICT (pattern) DO NOTHING"
      );

      // Proactively ensure PennyMac is marked as a fixed bill in existing transactions
      try {
        const pennymacLabel = await this.get("SELECT id FROM transaction_labels WHERE pattern = 'PENNYMAC'");
        if (pennymacLabel) {
          await this.run(
            "UPDATE transactions SET is_fixed = TRUE, label_id = $1, category = 'Mortgage' WHERE description LIKE '%PENNYMAC%'",
            [pennymacLabel.id]
          );
        }
      } catch (err) { /* ignore */ }

      // 3. Seed Credit Cards
      const cardCheck = await this.pool.query('SELECT COUNT(*) FROM credit_cards');
      if (cardCheck.rows[0].count === '0') {
        const cards = [
          ["Ollo Credit Card", 5021.95, 27.74, 7200.0, 169.0],
          ["Credit One Bank #1", 974.5, 27.49, 1600.0, 49.0],
          ["Credit One Bank #2", 256.42, 28.74, 500.0, 30.0],
          ["Amazon Store Card", 3522.49, 29.49, 10000.0, 259.15],
          ["TD Bank Double Up Visa Signature", 376.44, 28.49, 5500.0, 35.0]
        ];
        for (const [name, balance, apr, limit, min] of cards) {
          await this.pool.query(
            'INSERT INTO credit_cards (name, balance, apr, credit_limit, min_payment, user_id) VALUES ($1, $2, $3, $4, $5, 1)',
            [name, balance, apr, limit, min]
          );
        }
        log('DATABASE', '✓ Credit cards seeded');
      } else {
        // UPDATE existing cards with latest data from finance.db
        const cards = [
          ["Ollo Credit Card", 5072.35, 27.74, 7200.0, 169.0]
        ];
        for (const [name, balance, apr, limit, min] of cards) {
           await this.pool.query('UPDATE credit_cards SET balance = $1 WHERE name = $2', [balance, name]);
        }
      }

      // 4. Seed default goals if none exist
      const goalsCheck = await this.pool.query('SELECT COUNT(*) FROM savings_goals');
      if (parseInt(goalsCheck.rows[0].count) === 0) {
        const defaultGoals = [
          { name: 'Emergency Fund', target: 10000, current: 2000, date: '2026-12-31', priority: 1, icon: '\u{1f6e1}', color: '#e74c3c' },
          { name: 'Car Down Payment', target: 5000, current: 800, date: '2027-03-31', priority: 2, icon: '\u{1f3ce}', color: '#f39c12' },
          { name: 'Family Vacation', target: 3000, current: 400, date: '2027-06-30', priority: 3, icon: '\u{1f334}', color: '#2ecc71' }
        ];
        for (const g of defaultGoals) {
          await this.pool.query(
            'INSERT INTO savings_goals (user_id, name, target_amount, current_amount, target_date, priority, icon, color) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [1, g.name, g.target, g.current, g.date, g.priority, g.icon, g.color]
          );
        }
        log('DATABASE', '✓ Default savings goals seeded');
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
          // NORMALIZED DEDUP: Compare by normalized description to catch whitespace variants
          const normalized = txn.description ? txn.description.replace(/\s+/g, ' ').trim().toUpperCase() : '';
          const existing = await this.pool.query(
            `SELECT id FROM transactions 
             WHERE date = $1 AND regexp_replace(description, '[[:space:]]+', ' ', 'g') = $2 
             AND amount = $3`,
            [txn.date, normalized, txn.amount]
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
