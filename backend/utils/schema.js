import { reconcileTransfers } from './transfers.js';

export const PRIVATE_TABLES = [
  'categories', 'transaction_labels', 'transactions', 'staging_transactions',
  'credit_cards', 'savings_goals', 'plaid_connections', 'plaid_accounts', 'transaction_import_reviews',
  'accounts', 'category_budgets', 'money_plans', 'household_profiles', 'name_rules', 'import_batches', 'import_reviews'
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
  ['Transfer', 'Move', '#89959c'], ['Payments to people', 'People', '#9d8ab8'],
  ['Other income', 'Income', '#4f9a76'], ['Other', 'Other', '#8b929b']
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
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='sessions' AND column_name='last_activity_at') THEN
        DELETE FROM sessions;
        ALTER TABLE sessions ADD COLUMN last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      END IF;
    END $$;
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
    -- Redacted warning/error application logs for the admin console and monitoring (no financial data).
    CREATE TABLE IF NOT EXISTS app_logs (
      id BIGSERIAL PRIMARY KEY, entry_id TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL, level TEXT NOT NULL,
      source TEXT, message TEXT, request_id TEXT, route TEXT, status INTEGER, instance TEXT
    );
    CREATE INDEX IF NOT EXISTS app_logs_created_idx ON app_logs (created_at DESC);
    CREATE INDEX IF NOT EXISTS app_logs_request_idx ON app_logs (request_id);
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
    -- Tables created before created_at existed: old rows stay NULL so they are not mistaken for a fresh import.
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
    ALTER TABLE transactions ALTER COLUMN created_at SET DEFAULT NOW();
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_fixed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS label_id INTEGER REFERENCES transaction_labels(id);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_corrected BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS previous_category TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS correction_timestamp TIMESTAMPTZ;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plaid_transaction_id TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plaid_account_id TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_pending BOOLEAN NOT NULL DEFAULT FALSE;
    -- 'auto' = autopay / recurring pull, 'manual' = the user must pay it, NULL = not set.
    -- The first migration pre-fills debits whose statement wording makes the method clear (see utils/payMode.js).
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='transactions' AND column_name='pay_mode') THEN
        ALTER TABLE transactions ADD COLUMN pay_mode TEXT CHECK (pay_mode IN ('auto','manual'));
        UPDATE transactions SET pay_mode = CASE
          WHEN description ~* '\\m(auto ?-? ?pay|auto ?debit|recurring)\\M' THEN 'auto'
          WHEN description ~* '\\m(bill ?pay|online +(banking +)?(pmt|payment)|mobile +(pmt|payment)|web +pmt)\\M' THEN 'manual'
        END WHERE UPPER(direction) = 'DEBIT';
      END IF;
    END $$;
    -- Income override for deposits: 'income' = regular pay, 'other' = not pay (gifts, reimbursements), NULL = detect.
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS income_role TEXT CHECK (income_role IN ('income','other'));
    -- Accounts the user owns (or that transfers point at). Transfers between them are informational, never spending.
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'unknown' CHECK (kind IN ('checking','savings','credit_card','loan','investment','crypto','other','external','unknown')),
      institution TEXT, last4 TEXT CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_review')),
      suggested_kind TEXT, discovered_from TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS statement JSONB;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS account_id INTEGER;
    -- NULL = counts as spending/income; 'internal' | 'savings' | 'unknown' = money moved between your own accounts.
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_kind TEXT CHECK (transfer_kind IN ('internal','savings','unknown'));
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_account_id INTEGER;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_pair_id INTEGER;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_checked BOOLEAN NOT NULL DEFAULT FALSE;
    -- A manual category choice decides whether a row is a transfer, whichever route made the change.
    CREATE OR REPLACE FUNCTION sync_transfer_kind() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.category_corrected AND (TG_OP = 'INSERT' OR NEW.category IS DISTINCT FROM OLD.category OR NOT OLD.category_corrected) THEN
        NEW.transfer_kind := CASE
          WHEN NEW.category ~* '^(transfers?|internal transfers?)$' THEN 'internal'
          WHEN NEW.category ~* '^(savings|savings transfer)$' THEN 'savings'
          ELSE NULL END;
      END IF;
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS transactions_sync_transfer_kind ON transactions;
    CREATE TRIGGER transactions_sync_transfer_kind BEFORE INSERT OR UPDATE ON transactions
      FOR EACH ROW EXECUTE FUNCTION sync_transfer_kind();
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
    -- Pro licensing is account metadata: only the administrative connection may read or change it.
    CREATE TABLE IF NOT EXISTS user_licenses (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL DEFAULT 'pro',
      trial_started_at TIMESTAMPTZ, trial_ends_at TIMESTAMPTZ,
      granted_at TIMESTAMPTZ, granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      revoked_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- A customer's pending plan choice, approved by an administrator (there is no online checkout).
    ALTER TABLE user_licenses ADD COLUMN IF NOT EXISTS requested_plan TEXT;
    ALTER TABLE user_licenses ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS households (
      id SERIAL PRIMARY KEY, owner_user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
      name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS household_members (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','member')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS household_one_owner_idx ON household_members(household_id) WHERE role='owner';
    CREATE INDEX IF NOT EXISTS household_members_household_idx ON household_members(household_id);
    CREATE OR REPLACE FUNCTION validate_household_owner() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE owner_id INTEGER;
    BEGIN
      SELECT owner_user_id INTO owner_id FROM households WHERE id=NEW.household_id;
      IF (NEW.role='owner') IS DISTINCT FROM (NEW.user_id=owner_id) THEN
        RAISE EXCEPTION 'Household owner membership must match its owner identity';
      END IF;
      RETURN NEW;
    END $fn$;
    DROP TRIGGER IF EXISTS household_member_owner ON household_members;
    CREATE TRIGGER household_member_owner BEFORE INSERT OR UPDATE ON household_members
      FOR EACH ROW EXECUTE FUNCTION validate_household_owner();
    INSERT INTO households(owner_user_id,name)
      SELECT id,name || '''s household' FROM users u WHERE NOT EXISTS (
        SELECT 1 FROM household_members m WHERE m.user_id=u.id)
      ON CONFLICT(owner_user_id) DO NOTHING;
    INSERT INTO household_members(user_id,household_id,role)
      SELECT owner_user_id,id,'owner' FROM households ON CONFLICT(user_id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS household_invitations (
      id SERIAL PRIMARY KEY, household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      email TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
      invited_by INTEGER NOT NULL REFERENCES users(id), expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS household_invites_household_idx ON household_invitations(household_id);
    CREATE TABLE IF NOT EXISTS household_subscriptions (
      household_id INTEGER PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
      stripe_customer_id TEXT UNIQUE, stripe_subscription_id TEXT UNIQUE,
      plan TEXT CHECK(plan IN ('basic','pro')), status TEXT NOT NULL DEFAULT 'incomplete',
      trial_started_at TIMESTAMPTZ, trial_ends_at TIMESTAMPTZ, current_period_end TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE, trial_used BOOLEAN NOT NULL DEFAULT FALSE,
      checkout_session_id TEXT, checkout_expires_at TIMESTAMPTZ,
      reminder_sent_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS stripe_events (
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL, processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM app_migrations WHERE id='household-paid-plans-v1') THEN
        UPDATE users SET email_verified_at=NOW() WHERE password_hash IS NOT NULL;
        -- Preserve every legacy paid feature; old Pro included analytics, which is now in Pro.
        UPDATE user_licenses SET plan='pro',requested_plan=NULL,requested_at=NULL;
        INSERT INTO app_migrations(id) VALUES('household-paid-plans-v1');
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS category_budgets (
      id SERIAL PRIMARY KEY, category TEXT NOT NULL,
      monthly_amount NUMERIC(14,2) NOT NULL CHECK (monthly_amount > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE credit_cards ADD COLUMN IF NOT EXISTS included BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE credit_cards ADD COLUMN IF NOT EXISTS focus BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE credit_cards ADD COLUMN IF NOT EXISTS custom_rank INTEGER;
    ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS included BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS monthly_contribution NUMERIC(14,2);
    ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS contribution_day INTEGER;
    -- One row per user: debt-free program and goal settings plus per-month flexible amounts.
    CREATE TABLE IF NOT EXISTS money_plans (
      id SERIAL PRIMARY KEY, debt_strategy TEXT NOT NULL DEFAULT 'avalanche', debt_budget NUMERIC(14,2),
      goal_strategy TEXT NOT NULL DEFAULT 'priority', goal_budget NUMERIC(14,2),
      flex JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- One row per user: household details used only to pick public spending benchmarks (never shared).
    CREATE TABLE IF NOT EXISTS household_profiles (
      id SERIAL PRIMARY KEY, household_size INTEGER CHECK (household_size BETWEEN 1 AND 12),
      region TEXT CHECK (region IN ('northeast','midwest','south','west')),
      housing TEXT CHECK (housing IN ('own','rent')), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Rename rules: transactions whose description contains the pattern words show as name (see utils/naming.js).
    CREATE TABLE IF NOT EXISTS name_rules (
      id SERIAL PRIMARY KEY, pattern TEXT NOT NULL CHECK (length(pattern) BETWEEN 1 AND 256),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS display_name TEXT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS name_override BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS import_batches (
      id SERIAL PRIMARY KEY, source TEXT NOT NULL, account_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','undone')),
      legacy BOOLEAN NOT NULL DEFAULT FALSE, imported INTEGER NOT NULL DEFAULT 0,
      duplicates INTEGER NOT NULL DEFAULT 0, statement_before JSONB, statement_after JSONB,
      statement_changed BOOLEAN NOT NULL DEFAULT FALSE,
      backup JSONB NOT NULL DEFAULT '[]'::jsonb, undone_at TIMESTAMPTZ
    );
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS restore_guard JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE TABLE IF NOT EXISTS import_reviews (
      id SERIAL PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, payload JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
    );
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS import_batch_id INTEGER;
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
    CREATE UNIQUE INDEX IF NOT EXISTS category_budgets_user_category_key ON category_budgets (user_id, category);
    CREATE UNIQUE INDEX IF NOT EXISTS money_plans_user_key ON money_plans (user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS household_profiles_user_key ON household_profiles (user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS labels_user_pattern_key ON transaction_labels (user_id, pattern);
    CREATE UNIQUE INDEX IF NOT EXISTS name_rules_user_pattern_key ON name_rules (user_id, pattern);
    CREATE INDEX IF NOT EXISTS transactions_user_date_idx ON transactions (user_id, date);
    CREATE UNIQUE INDEX IF NOT EXISTS transactions_user_plaid_transaction_key
      ON transactions (user_id, plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS plaid_connections_user_item_key ON plaid_connections (user_id, item_id);
    CREATE UNIQUE INDEX IF NOT EXISTS plaid_accounts_user_account_key ON plaid_accounts (user_id, account_id);
    CREATE UNIQUE INDEX IF NOT EXISTS plaid_accounts_id_user_key ON plaid_accounts (id, user_id);
    CREATE INDEX IF NOT EXISTS plaid_accounts_user_cashflow_idx ON plaid_accounts (user_id, use_for_cashflow);
    CREATE INDEX IF NOT EXISTS import_reviews_user_status_idx ON transaction_import_reviews (user_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS transactions_user_account_idx ON transactions (user_id, account_id);
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
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_tenant_account_fk') THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_tenant_account_fk
          FOREIGN KEY (account_id, user_id) REFERENCES accounts (id, user_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_tenant_import_fk') THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_tenant_import_fk
          FOREIGN KEY (import_batch_id, user_id) REFERENCES import_batches (id, user_id);
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
    REVOKE ALL ON users, sessions, auth_attempts, password_reset_tokens, support_grants, audit_events, user_licenses, app_logs,
      households,household_members,household_invitations,household_subscriptions,stripe_events,app_migrations,email_verification_tokens
      FROM PUBLIC, finance_app_runtime;
  `);
  await normalizeStoredDates(client);
  await backfillTransfers(client);
  // Old imports shared one transaction timestamp. Never guess boundaries for undated/manual rows.
  await client.query(`
    ALTER TABLE import_batches NO FORCE ROW LEVEL SECURITY;
    WITH batches AS (
      INSERT INTO import_batches (user_id,source,account_id,created_at,legacy,imported)
      SELECT user_id,source,account_id,created_at,TRUE,COUNT(*)::int FROM transactions
      WHERE import_batch_id IS NULL AND created_at IS NOT NULL
        AND source ~* '(\\.(csv|tsv|ofx|qfx|qbo|pdf)$|import)'
      GROUP BY user_id,source,account_id,created_at
      RETURNING id,user_id,source,account_id,created_at
    )
    UPDATE transactions t SET import_batch_id=b.id FROM batches b
    WHERE t.import_batch_id IS NULL AND t.user_id=b.user_id AND t.source=b.source
      AND t.account_id IS NOT DISTINCT FROM b.account_id AND t.created_at=b.created_at;
    CREATE INDEX IF NOT EXISTS transactions_import_batch_idx ON transactions (user_id,import_batch_id);
    CREATE INDEX IF NOT EXISTS transactions_import_review_idx ON transactions (user_id,import_batch_id,date DESC,id DESC);
    CREATE INDEX IF NOT EXISTS import_batches_review_idx ON import_batches (user_id,id DESC);
    -- Undone rows retain their IDs. A restart must not reuse those IDs for new transactions.
    SELECT setval(pg_get_serial_sequence('transactions','id'),
      GREATEST((SELECT last_value FROM transactions_id_seq),
        COALESCE((SELECT MAX((r->>'id')::integer) FROM import_batches b,
          LATERAL jsonb_array_elements(b.backup) r),1)),TRUE)
    WHERE EXISTS (SELECT 1 FROM import_batches WHERE jsonb_array_length(backup)>0);
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

// Transaction dates are TEXT and older CSV imports stored MM/DD/YYYY. One unreadable value (e.g. '') makes every
// `date::date` query fail and mixed formats sort wrongly, so stored dates are rewritten to ISO YYYY-MM-DD and values
// PostgreSQL cannot read become NULL. Runs inside the migration transaction; FORCE RLS is restored right after.
export async function normalizeStoredDates(client) {
  await client.query(`
    ALTER TABLE transactions NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE staging_transactions NO FORCE ROW LEVEL SECURITY;
    DO $$
    DECLARE r RECORD; t TEXT; d DATE;
    BEGIN
      PERFORM set_config('datestyle', 'ISO, MDY', true);
      FOREACH t IN ARRAY ARRAY['transactions', 'staging_transactions'] LOOP
        FOR r IN EXECUTE format('SELECT DISTINCT date FROM %I WHERE date IS NOT NULL AND date !~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}$''', t) LOOP
          BEGIN
            d := btrim(r.date)::date;
            EXECUTE format('UPDATE %I SET date = $1 WHERE date = $2', t) USING to_char(d, 'YYYY-MM-DD'), r.date;
          EXCEPTION WHEN others THEN
            RAISE NOTICE 'Clearing unreadable transaction date %', r.date;
            EXECUTE format('UPDATE %I SET date = NULL WHERE date = $1', t) USING r.date;
          END;
        END LOOP;
      END LOOP;
    END $$;
  `);
}

// One-time (then incremental) transfer classification for rows imported before accounts existed.
// Only users with unchecked rows are processed, so a normal restart does no work.
export async function backfillTransfers(client) {
  for (const table of ['transactions', 'accounts', 'categories']) await client.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
  const users = (await client.query('SELECT DISTINCT user_id FROM transactions WHERE NOT transfer_checked AND user_id IS NOT NULL', [])).rows || [];
  for (const { user_id: userId } of users) await reconcileTransfers(client, userId);
}

export async function seedUserCategories(client, userId) {
  for (const [name, icon, color] of DEFAULT_CATEGORIES) {
    await client.query(
      'INSERT INTO categories (user_id, name, icon, color) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, name) DO NOTHING',
      [userId, name, icon, color]
    );
  }
}
