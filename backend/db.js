import pg from 'pg';
import { currentUserId, currentReadOnly, currentLoginId } from './utils/tenant.js';
import { migratePrivateSchema, seedUserCategories } from './utils/schema.js';
import { log } from './utils/logger.js';

const { Pool } = pg;
const rawPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined
});

// Only authentication and startup may use this administrative connection.
export async function administrativeTransaction(callback) {
  const client = await rawPool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export default class Database {
  constructor() {
    this.pool = { query: (sql, params) => this.query(sql, params) };
  }

  async init() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    await administrativeTransaction(async client => {
      await migratePrivateSchema(client);
      // Existing records stay with user 1. Do not seed personal debts, change flags,
      // or overwrite balances/categories on startup.
      await client.query('SET LOCAL ROLE finance_app_runtime');
      await client.query("SELECT set_config('app.user_id', '1', true)");
      await seedUserCategories(client, 1);
    });
    log('DATABASE', 'Private account schema ready');
  }

  async transaction(callback) {
    const userId = currentUserId();
    const client = await rawPool.connect();
    try {
      await client.query('BEGIN');
      if (currentReadOnly()) await client.query('SET TRANSACTION READ ONLY');
      const loginId = currentLoginId();
      if (loginId) {
        const member = (await client.query(`SELECT m.user_id FROM household_members m JOIN households h ON h.id=m.household_id
          WHERE m.user_id=$1 AND h.owner_user_id=$2 ${currentReadOnly() ? '' : 'FOR SHARE OF m'}`, [loginId, userId])).rows[0];
        if (!member) throw Object.assign(new Error('Household membership changed. Sign in again.'), { status: 403 });
      }
      // Read-only support access is enforced by PostgreSQL, not just route checks.
      await client.query('SET LOCAL ROLE finance_app_runtime');
      await client.query("SELECT set_config('app.user_id', $1, true)", [String(userId)]);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async query(sql, params = []) {
    return this.transaction(client => client.query(sql, params));
  }

  async all(sql, params = []) {
    return (await this.query(sql, params)).rows;
  }

  async get(sql, params = []) {
    return (await this.query(sql, params)).rows[0];
  }

  async run(sql, params = []) {
    return this.query(sql, params);
  }

  async close() {
    await rawPool.end();
  }
}
