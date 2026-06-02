import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import { log } from './utils/logger.js';

export default class Database {
  constructor() {
    this.dbPath = '/opt/data/myfinanceapp-v2.db';
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, async (err) => {
        if (err) {
          log('DATABASE', `❌ Connection failed: ${err.message}`);
          reject(err);
        } else {
          log('DATABASE', `✓ Connected to ${this.dbPath}`);
          await this.createTables();
          await this.seedData();
          resolve();
        }
      });
    });
  }

  async createTables() {
    const sql = `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE,
        role TEXT DEFAULT 'admin'
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        description TEXT,
        category TEXT,
        amount REAL,
        direction TEXT,
        balance REAL,
        user_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS credit_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        balance REAL,
        apr REAL,
        payoff_priority INTEGER,
        user_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS savings_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        target_amount REAL,
        current_amount REAL,
        target_date TEXT,
        category TEXT,
        user_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        token TEXT UNIQUE,
        expires_at TEXT,
        created_at TEXT
      );
    `;

    for (const statement of sql.split(';').filter(s => s.trim())) {
      await this.run(statement);
    }
    log('DATABASE', '✓ Tables created');
  }

  async seedData() {
    // Check if data exists
    const count = await new Promise((resolve) => {
      this.db.get('SELECT COUNT(*) as count FROM transactions', (err, row) => {
        resolve(row?.count || 0);
      });
    });

    if (count > 0) {
      log('DATABASE', `✓ Data already seeded (${count} transactions)`);
      return;
    }

    log('DATABASE', 'Seeding test data...');
    // Users
    await this.run('INSERT INTO users (id, name, email, role) VALUES (1, ?, ?, ?)', ['Shak', 'shak@example.com', 'admin']);
    await this.run('INSERT INTO users (id, name, email, role) VALUES (2, ?, ?, ?)', ['Zunaira', 'zunaira@example.com', 'viewer']);

    // Credit cards
    await this.run('INSERT INTO credit_cards (name, balance, apr, payoff_priority, user_id) VALUES (?, ?, ?, ?, ?)', 
      ['Amazon Store Card', 3522, 29.49, 1, 1]);
    await this.run('INSERT INTO credit_cards (name, balance, apr, payoff_priority, user_id) VALUES (?, ?, ?, ?, ?)',
      ['Ollo Card', 5022, 27.74, 2, 1]);
    await this.run('INSERT INTO credit_cards (name, balance, apr, payoff_priority, user_id) VALUES (?, ?, ?, ?, ?)',
      ['Credit One #1', 975, 27.49, 3, 1]);

    // Sample transactions (last 30 days from May 22, 2026)
    const transactions = [
      { date: '2026-05-22', desc: 'Paycheck (Biweekly)', cat: 'Income', amt: 6211.68, dir: 'credit' },
      { date: '2026-05-23', desc: 'Mortgage Payment', cat: 'Housing', amt: 1185.65, dir: 'debit' },
      { date: '2026-05-24', desc: 'Grocery Store', cat: 'Food', amt: 125.43, dir: 'debit' },
      { date: '2026-05-25', desc: 'Gas Station', cat: 'Auto', amt: 65.00, dir: 'debit' },
      { date: '2026-05-28', desc: 'Dining Out', cat: 'Dining', amt: 87.50, dir: 'debit' },
      { date: '2026-05-29', desc: 'Online Shopping', cat: 'Shopping', amt: 234.99, dir: 'debit' },
      { date: '2026-06-01', desc: 'Utilities', cat: 'Utilities', amt: 150.00, dir: 'debit' },
      { date: '2026-06-02', desc: 'Car Payment', cat: 'Auto Loan', amt: 443.00, dir: 'debit' },
      { date: '2026-06-03', desc: 'Paycheck (Biweekly)', cat: 'Income', amt: 6211.68, dir: 'credit' },
    ];

    let balance = 339.01;
    for (const tx of transactions) {
      balance += tx.dir === 'credit' ? tx.amt : -tx.amt;
      await this.run(
        'INSERT INTO transactions (date, description, category, amount, direction, balance, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [tx.date, tx.desc, tx.cat, tx.amt, tx.dir, balance, 1]
      );
    }

    // Savings goals
    await this.run('INSERT INTO savings_goals (name, target_amount, current_amount, target_date, category, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      ['Debt-Free', 10151.80, 0, '2027-06-30', 'Debt Payoff', 1]);
    await this.run('INSERT INTO savings_goals (name, target_amount, current_amount, target_date, category, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      ['Emergency Fund', 25000, 445, '2027-12-31', 'Emergency', 1]);
    await this.run('INSERT INTO savings_goals (name, target_amount, current_amount, target_date, category, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      ['Family Vacation', 3280, 0, '2026-12-31', 'Vacation', 1]);

    log('DATABASE', '✓ Test data seeded');
  }

  async run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
      });
    });
  }

  async get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
}
