import pg from 'pg';
import { log } from './utils/logger.js';

const { Pool } = pg;

export default class Database {
  constructor() {
    // Use Railway's private internal PostgreSQL connection
    // Format: postgresql://postgres:PASSWORD@postgres.railway.internal:5432/railway
    const connectionString = 'postgresql://postgres:ywifkZbCSkleSblFMnAnjamAAleLiTsV@postgres.railway.internal:5432/railway';
    
    this.pool = new Pool({
      connectionString,
      ssl: false  // No SSL needed for internal Railway connection
    });
    
    log('DATABASE', `Connecting to PostgreSQL on postgres.railway.internal:5432...`);
  }

  async init() {
    try {
      const result = await this.pool.query('SELECT NOW()');
      log('DATABASE', `✓ Connected to PostgreSQL: ${result.rows[0].now}`);
      await this.createTables();
      await this.seedData();
    } catch (err) {
      log('DATABASE', `❌ Connection failed: ${err.message}`);
      throw err;
    }
  }

  async createTables() {
    // PostgreSQL doesn't support multiple statements in one query, so execute separately
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
        balance REAL,
        source TEXT,
        user_id INTEGER REFERENCES users(id)
      )`,
      
      `CREATE TABLE IF NOT EXISTS credit_cards (
        id SERIAL PRIMARY KEY,
        name TEXT,
        balance REAL,
        limit REAL,
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

  async seedData() {
    try {
      // Check if data already exists
      const userCheck = await this.pool.query('SELECT COUNT(*) FROM users');
      if (userCheck.rows[0].count > 0) {
        log('DATABASE', '✓ Data already seeded, skipping');
        return;
      }

      // Insert users
      await this.pool.query(
        "INSERT INTO users (name, email, role) VALUES ($1, $2, $3)",
        ['Shak', 'shak@example.com', 'admin']
      );
      await this.pool.query(
        "INSERT INTO users (name, email, role) VALUES ($1, $2, $3)",
        ['Zunaira', 'zunaira@example.com', 'viewer']
      );

      // Insert transactions
      const transactions = [
        ['2026-05-29', 'Biweekly Paycheck', 'income', 1185.65, 'credit', 994.08, 'td-checking'],
        ['2026-05-28', 'Whole Foods', 'groceries', 85.32, 'debit', -91.57, 'td-checking'],
        ['2026-05-27', 'Electric Bill', 'utilities', 145.00, 'debit', -6.25, 'td-checking'],
        ['2026-05-26', 'Gas', 'transportation', 45.00, 'debit', 38.75, 'td-checking'],
        ['2026-05-25', 'Costco', 'groceries', 120.50, 'debit', 83.75, 'td-checking'],
        ['2026-05-24', 'Netflix', 'entertainment', 15.99, 'debit', 204.25, 'credit-card'],
        ['2026-05-23', 'Chipotle', 'dining', 12.45, 'debit', 216.70, 'credit-card'],
        ['2026-05-22', 'Target', 'shopping', 67.89, 'debit', 284.59, 'credit-card'],
        ['2026-05-20', 'Biweekly Paycheck', 'income', 1185.65, 'credit', 352.48, 'td-checking']
      ];

      for (const txn of transactions) {
        await this.pool.query(
          'INSERT INTO transactions (date, description, category, amount, direction, balance, source, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [...txn, 1]
        );
      }

      // Insert credit cards
      await this.pool.query(
        'INSERT INTO credit_cards (name, balance, limit, apr, user_id) VALUES ($1, $2, $3, $4, $5)',
        ['Chase Sapphire', 3245.67, 15000, 18.99, 1]
      );
      await this.pool.query(
        'INSERT INTO credit_cards (name, balance, limit, apr, user_id) VALUES ($1, $2, $3, $4, $5)',
        ['Amex Gold', 2890.45, 20000, 19.99, 1]
      );
      await this.pool.query(
        'INSERT INTO credit_cards (name, balance, limit, apr, user_id) VALUES ($1, $2, $3, $4, $5)',
        ['Citi Double Cash', 4015.68, 12000, 17.99, 1]
      );

      // Insert savings goals
      await this.pool.query(
        'INSERT INTO savings_goals (name, target, current, deadline, user_id) VALUES ($1, $2, $3, $4, $5)',
        ['Emergency Fund', 10000, 2500, '2026-12-31', 1]
      );
      await this.pool.query(
        'INSERT INTO savings_goals (name, target, current, deadline, user_id) VALUES ($1, $2, $3, $4, $5)',
        ['Vacation', 5000, 1200, '2026-09-30', 1]
      );
      await this.pool.query(
        'INSERT INTO savings_goals (name, target, current, deadline, user_id) VALUES ($1, $2, $3, $4, $5)',
        ['Home Improvement', 8000, 0, '2027-06-30', 1]
      );

      log('DATABASE', '✓ Data seeded successfully');
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

  async close() {
    await this.pool.end();
    log('DATABASE', '✓ Connection closed');
  }
}
