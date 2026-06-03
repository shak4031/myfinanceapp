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
        balance REAL,
        source TEXT,
        user_id INTEGER REFERENCES users(id)
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

      // Insert comprehensive categories
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
        ['Other', '📦', '#424242']
      ];

      for (const [name, icon, color] of categories) {
        await this.pool.query(
          'INSERT INTO categories (name, icon, color) VALUES ($1, $2, $3)',
          [name, icon, color]
        );
      }

      // Insert transactions with comprehensive category data
      const transactions = [
        ['2026-06-03', 'Biweekly Paycheck', 'Salary', 6211.68, 'credit', 12450.32, 'td-checking'],
        ['2026-06-02', 'Whole Foods', 'Groceries', 85.32, 'debit', 6238.64, 'td-checking'],
        ['2026-06-02', 'Electric Bill', 'Utilities', 145.00, 'debit', 6323.96, 'td-checking'],
        ['2026-06-01', 'Shell Gas', 'Gas', 45.00, 'debit', 6468.96, 'td-checking'],
        ['2026-05-31', 'Costco', 'Groceries', 120.50, 'debit', 6513.96, 'td-checking'],
        ['2026-05-30', 'Netflix', 'Subscriptions', 15.99, 'debit', 6634.46, 'td-checking'],
        ['2026-05-30', 'Chipotle', 'Dining', 12.45, 'debit', 6650.45, 'td-checking'],
        ['2026-05-29', 'Target', 'Shopping', 67.89, 'debit', 6662.90, 'td-checking'],
        ['2026-05-28', 'Uber', 'Transportation', 23.50, 'debit', 6730.79, 'td-checking'],
        ['2026-05-27', 'Home Depot', 'Home', 156.78, 'debit', 6754.29, 'td-checking'],
        ['2026-05-26', 'Amazon Prime', 'Subscriptions', 14.99, 'debit', 6911.07, 'td-checking'],
        ['2026-05-25', 'Dr. Smith Visit', 'Healthcare', 150.00, 'debit', 6926.06, 'td-checking'],
        ['2026-05-24', 'Pet Food Store', 'Pet Care', 45.60, 'debit', 7076.06, 'td-checking'],
        ['2026-05-23', 'AMC Theaters', 'Entertainment', 28.00, 'debit', 7121.66, 'td-checking'],
        ['2026-05-22', 'Starbucks', 'Dining', 6.45, 'debit', 7150.66, 'td-checking'],
        ['2026-05-21', 'Microsoft 365', 'Subscriptions', 6.99, 'debit', 7157.11, 'td-checking'],
        ['2026-05-20', 'Biweekly Paycheck', 'Salary', 6211.68, 'credit', 7164.10, 'td-checking'],
        ['2026-05-19', 'Gym Membership', 'Entertainment', 50.00, 'debit', 952.42, 'td-checking'],
        ['2026-05-18', 'Trader Joes', 'Groceries', 73.45, 'debit', 1002.42, 'td-checking'],
        ['2026-05-17', 'Allstate Insurance', 'Insurance', 180.00, 'debit', 1075.87, 'td-checking'],
        ['2026-05-16', 'Car Maintenance', 'Maintenance', 200.00, 'debit', 1255.87, 'td-checking'],
        ['2026-05-15', 'Water Bill', 'Utilities', 60.00, 'debit', 1455.87, 'td-checking'],
        ['2026-05-14', 'Vacation Fund', 'Savings', 500.00, 'debit', 1515.87, 'td-checking'],
        ['2026-05-13', 'Airplane Ticket', 'Travel', 450.00, 'debit', 2015.87, 'td-checking'],
        ['2026-05-12', 'Birthday Gift', 'Gifts', 75.00, 'debit', 2465.87, 'td-checking']
      ];

      for (const txn of transactions) {
        await this.pool.query(
          'INSERT INTO transactions (date, description, category, amount, direction, balance, source, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [...txn, 1]
        );
      }

      // Insert credit cards
      await this.pool.query(
        'INSERT INTO credit_cards (name, balance, "limit", apr, user_id) VALUES ($1, $2, $3, $4, $5)',
        ['Chase Sapphire', 3245.67, 15000, 18.99, 1]
      );
      await this.pool.query(
        'INSERT INTO credit_cards (name, balance, "limit", apr, user_id) VALUES ($1, $2, $3, $4, $5)',
        ['Amex Gold', 2890.45, 20000, 19.99, 1]
      );
      await this.pool.query(
        'INSERT INTO credit_cards (name, balance, "limit", apr, user_id) VALUES ($1, $2, $3, $4, $5)',
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
