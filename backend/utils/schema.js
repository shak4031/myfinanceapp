export const PRIVATE_TABLES = [
  'categories', 'transaction_labels', 'transactions', 'staging_transactions',
  'credit_cards', 'savings_goals', 'plaid_connections', 'plaid_accounts',
  'transaction_import_reviews'
];

export const DEFAULT_CATEGORIES = [
  ['Groceries', 'Cart', '#36a38b'], ['Utilities', 'Bolt', '#5885d8'],
  ['EV Charging', 'EV', '#47a3ba'], ['Gas', 'Fuel', '#d59b4d'],
  ['Dining', 'Dining', '#dc8a6a'], ['Shopping', 'Bag', '#a782bf'],
  ['Entertainment', 'Play', '#ce7eab'], ['Healthcare', 'Health', '#5ca3b3'],
  ['Insurance', 'Shield', '#8095c5'], ['Subscriptions', 'Repeat', '#b59c53'],
  ['Transportation', 'Car', '#8a9c79'], ['Home', 'Home', '#b1967f'],
  ['Salary', 'Income', '#318966'], ['Mortgage', 'House', '#719371'],
  ['Savings', 'Save', '#369c85'], ['Credit Cards', 'Card', '#b5757b'],
  ['Car Loans', 'Loan', '#9a897d'], ['Internet', 'WiFi', '#638cb4'],
  ['Transfer', 'Move', '#89959c'], ['Other', 'Other', '#8b929b']
];

export async function migratePrivateSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, role TEXT DEFAULT 'user'
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';
    INSERT INTO users (id, name, role) VALUES (1, 'Owner', 'admin') ON CONFLICT (id) DO NOTHING;
    SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT MAX(id) FROM users), 1));
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_key ON users (lower(email));
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
    CREATE TABLE IF NOT EXISTS auth_attempts (
      key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at TIMESTAMPTZ NOT NULL
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS support_grants (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_level TEXT NOT NULL CHECK (access_level IN ('read', 'write')), reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS support_grants_user_idx ON support_grants (user_id, expires_at);
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS actor_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS support_grant_id INTEGER REFERENCES support_grants(id) ON DELETE CASCADE;
    CREATE TABLE IF NOT EXISTS audit_events (
      id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event_type TEXT NOT NULL, outcome TEXT NOT NULL, actor_user_id INTEGER, subject_user_id INTEGER,
      support_grant_id INTEGER, request_id TEXT, ip_hash TEXT, email_hash TEXT,
      method TEXT, path TEXT, status INTEGER, detail JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_events_type_idx ON audit_events (event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_events_subject_idx ON audit_events (subject_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_events_request_idx ON audit_events (request_id);
    CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $fn$;
    DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
    CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, icon TEXT, color TEXT
    );
    CREATE TABLE IF NOT EXISTS transaction_labels (
      id SERIAL PRIMARY KEY, pattern TEXT NOT NULL, display_label TEXT,
      category_id INTEGER REFERENCES categories(id), is_fixed BOOLEAN DEFAULT FALSE,
      is_excluded BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY, date TEXT, description TEXT, label_id INTEGER REFERENCES transaction_labels(id),
      amount NUMERIC(14,2), direction TEXT, balance NUMERIC(14,2), source TEXT,
      user_id INTEGER REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_fixed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS label_id INTEGER REFERENCES transaction_labels(id);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_corrected BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS previous_category TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS correction_timestamp TIMESTAMPTZ;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plaid_transaction_id TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plaid_account_id TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_pending BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS staging_transactions (
      id SERIAL PRIMARY KEY, date TEXT, description TEXT, amount NUMERIC(14,2), direction TEXT,
      balance NUMERIC(14,2), source TEXT, status TEXT DEFAULT 'pending', error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS credit_cards (
      id SERIAL PRIMARY KEY, name TEXT, balance NUMERIC(14,2), apr NUMERIC(7,3),
      credit_limit NUMERIC(14,2), min_payment NUMERIC(14,2), due_date TEXT, user_id INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS savings_goals (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), name TEXT NOT NULL,
      target_amount NUMERIC(14,2) DEFAULT 0, current_amount NUMERIC(14,2) DEFAULT 0,
      target_date TEXT, priority INTEGER DEFAULT 1, icon TEXT DEFAULT 'Save',
      color TEXT DEFAULT '#369c85', notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS plaid_connections (
      id SERIAL PRIMARY KEY, item_id TEXT NOT NULL, access_token_ciphertext TEXT NOT NULL,
      institution_name TEXT, cursor TEXT, status TEXT NOT NULL DEFAULT 'connected',
      last_sync_at TIMESTAMPTZ, last_sync_attempt_at TIMESTAMPTZ, last_error_code TEXT,
      user_id INTEGER NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS plaid_accounts (
      id SERIAL PRIMARY KEY, connection_id INTEGER NOT NULL, account_id TEXT NOT NULL,
      name TEXT NOT NULL, official_name TEXT, mask TEXT, type TEXT, subtype TEXT,
      current_balance NUMERIC(14,2), available_balance NUMERIC(14,2), iso_currency_code TEXT,
      use_for_cashflow BOOLEAN NOT NULL DEFAULT FALSE, balance_checked_at TIMESTAMPTZ,
      user_id INTEGER NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transaction_import_reviews (
      id SERIAL PRIMARY KEY, source TEXT NOT NULL, date TEXT NOT NULL, description TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL, direction TEXT NOT NULL, balance NUMERIC(14,2), category TEXT,
      plaid_transaction_id TEXT, plaid_account_id TEXT, is_pending BOOLEAN NOT NULL DEFAULT FALSE,
      candidate_transaction_ids INTEGER[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending', matched_transaction_id INTEGER, resolution_transaction_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ,
      user_id INTEGER NOT NULL REFERENCES users(id)
    );
    ALTER TABLE plaid_connections ADD COLUMN IF NOT EXISTS last_sync_attempt_at TIMESTAMPTZ;
    ALTER TABLE plaid_accounts ADD COLUMN IF NOT EXISTS balance_checked_at TIMESTAMPTZ;
    ALTER TABLE transaction_import_reviews ADD COLUMN IF NOT EXISTS category TEXT;
    ALTER TABLE transaction_import_reviews ADD COLUMN IF NOT EXISTS matched_transaction_id INTEGER;
    ALTER TABLE credit_cards ADD COLUMN IF NOT EXISTS debt_type TEXT NOT NULL DEFAULT 'credit_card';
    ALTER TABLE credit_cards ADD COLUMN IF NOT EXISTS payment_in_history BOOLEAN NOT NULL DEFAULT TRUE;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='savings_goals' AND column_name='target')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='savings_goals' AND column_name='target_amount')
        THEN ALTER TABLE savings_goals RENAME COLUMN target TO target_amount; END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='savings_goals' AND column_name='current')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='savings_goals' AND column_name='current_amount')
        THEN ALTER TABLE savings_goals RENAME COLUMN current TO current_amount; END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='savings_goals' AND column_name='deadline')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='savings_goals' AND column_name='target_date')
        THEN ALTER TABLE savings_goals RENAME COLUMN deadline TO target_date; END IF;
    END $$;
    ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS target_amount NUMERIC(14,2) DEFAULT 0;
    ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS current_amount NUMERIC(14,2) DEFAULT 0;
    ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS target_date TEXT;
    ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT 'Save';
    ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#369c85';
    ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='savings_goals' AND column_name='target') THEN
        UPDATE savings_goals SET target_amount = COALESCE(target_amount, target);
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='savings_goals' AND column_name='current') THEN
        UPDATE savings_goals SET current_amount = COALESCE(current_amount, current);
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='savings_goals' AND column_name='deadline') THEN
        UPDATE savings_goals SET target_date = COALESCE(target_date, deadline);
      END IF;
    END $$;
    ALTER TABLE transaction_labels ADD COLUMN IF NOT EXISTS match_type TEXT NOT NULL DEFAULT 'regex';
    ALTER TABLE transaction_labels ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE transaction_labels ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;
    ALTER TABLE transaction_labels DROP CONSTRAINT IF EXISTS transaction_labels_pattern_key;
  `);
  for (const table of PRIVATE_TABLES) {
    await client.query(`
      ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
      UPDATE ${table} SET user_id = 1 WHERE user_id IS NULL;
      ALTER TABLE ${table} ALTER COLUMN user_id SET NOT NULL;
      ALTER TABLE ${table} ALTER COLUMN user_id SET DEFAULT NULLIF(current_setting('app.user_id', true), '')::integer;
      CREATE UNIQUE INDEX IF NOT EXISTS ${table}_id_user_key ON ${table} (id, user_id);
      CREATE INDEX IF NOT EXISTS ${table}_user_idx ON ${table} (user_id);
      SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 0), 1), EXISTS(SELECT 1 FROM ${table}));
    `);
  }
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS categories_user_name_key ON categories (user_id, name);
    CREATE UNIQUE INDEX IF NOT EXISTS labels_user_pattern_key ON transaction_labels (user_id, pattern);
    CREATE INDEX IF NOT EXISTS transactions_user_date_idx ON transactions (user_id, date);
    CREATE UNIQUE INDEX IF NOT EXISTS transactions_user_plaid_transaction_key
      ON transactions (user_id, plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS plaid_connections_user_item_key ON plaid_connections (user_id, item_id);
    CREATE UNIQUE INDEX IF NOT EXISTS plaid_accounts_user_account_key ON plaid_accounts (user_id, account_id);
    CREATE UNIQUE INDEX IF NOT EXISTS plaid_accounts_id_user_key ON plaid_accounts (id, user_id);
    CREATE INDEX IF NOT EXISTS plaid_accounts_user_cashflow_idx ON plaid_accounts (user_id, use_for_cashflow);
    CREATE INDEX IF NOT EXISTS import_reviews_user_status_idx ON transaction_import_reviews (user_id, status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS import_reviews_user_plaid_transaction_key
      ON transaction_import_reviews (user_id, plaid_transaction_id)
      WHERE plaid_transaction_id IS NOT NULL AND status = 'pending';
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plaid_accounts_tenant_connection_fk') THEN
        ALTER TABLE plaid_accounts ADD CONSTRAINT plaid_accounts_tenant_connection_fk
          FOREIGN KEY (connection_id, user_id) REFERENCES plaid_connections (id, user_id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_reviews_tenant_resolution_fk') THEN
        ALTER TABLE transaction_import_reviews ADD CONSTRAINT transaction_reviews_tenant_resolution_fk
          FOREIGN KEY (resolution_transaction_id, user_id) REFERENCES transactions (id, user_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_reviews_tenant_match_fk') THEN
        ALTER TABLE transaction_import_reviews ADD CONSTRAINT transaction_reviews_tenant_match_fk
          FOREIGN KEY (matched_transaction_id, user_id) REFERENCES transactions (id, user_id);
      END IF;
    END $$;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'labels_tenant_category_fk') THEN
        ALTER TABLE transaction_labels ADD CONSTRAINT labels_tenant_category_fk
          FOREIGN KEY (category_id, user_id) REFERENCES categories (id, user_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_tenant_label_fk') THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_tenant_label_fk
          FOREIGN KEY (label_id, user_id) REFERENCES transaction_labels (id, user_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finance_app_runtime') THEN
        CREATE ROLE finance_app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finance_app_runtime' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
        RAISE EXCEPTION 'finance_app_runtime must be NOLOGIN NOSUPERUSER NOBYPASSRLS';
      END IF;
      EXECUTE format('GRANT finance_app_runtime TO %I', current_user);
    END $$;
    GRANT USAGE ON SCHEMA public TO finance_app_runtime;
    REVOKE ALL ON users, sessions, auth_attempts, password_reset_tokens, support_grants, audit_events
      FROM PUBLIC, finance_app_runtime;
  `);
  for (const table of PRIVATE_TABLES) {
    await client.query(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS private_user ON ${table};
      CREATE POLICY private_user ON ${table} TO finance_app_runtime
        USING (user_id = NULLIF(current_setting('app.user_id', true), '')::integer)
        WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::integer);
      GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO finance_app_runtime;
      GRANT USAGE, SELECT ON SEQUENCE ${table}_id_seq TO finance_app_runtime;
    `);
  }
}

export async function seedUserCategories(client, userId) {
  for (const [name, icon, color] of DEFAULT_CATEGORIES) {
    await client.query(
      'INSERT INTO categories (user_id, name, icon, color) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, name) DO NOTHING',
      [userId, name, icon, color]
    );
  }
}
