import pg from 'pg';

const { Pool } = pg;

// Schema version tracking: uses the 'meta' table with key 'schema_version'
// instead of SQLite's PRAGMA user_version.

const MIGRATIONS = [
  // M1: Initial schema
  `
  CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    stremio_user_id TEXT NOT NULL UNIQUE,
    stremio_email TEXT NOT NULL,
    auth_key_enc BYTEA NOT NULL,
    addon_token TEXT NOT NULL UNIQUE,
    active_profile_id INTEGER,
    addon_installed INTEGER,
    enc_version INTEGER NOT NULL DEFAULT 2,
    created_at BIGINT NOT NULL,
    last_login_at BIGINT NOT NULL,
    notifs_foreign INTEGER NOT NULL DEFAULT 0,
    last_addon_at BIGINT,
    last_seen_at BIGINT
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    avatar_preset TEXT NOT NULL,
    avatar_colour TEXT NOT NULL,
    library_enc BYTEA NOT NULL,
    addons_enc BYTEA NOT NULL,
    notifs_enc BYTEA,
    library_count INTEGER NOT NULL,
    addon_count INTEGER NOT NULL,
    notif_count INTEGER,
    snapshot_taken_at BIGINT NOT NULL,
    stremio_user_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    deleted_at BIGINT,
    photo_enc BYTEA,
    photo_hash TEXT,
    passcode_hash TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS profiles_account_name ON profiles (account_id, name) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS profiles_account ON profiles (account_id);

  ALTER TABLE accounts ADD CONSTRAINT fk_accounts_active_profile
    FOREIGN KEY (active_profile_id) REFERENCES profiles (id) ON DELETE SET NULL;

  CREATE TABLE IF NOT EXISTS backups (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('original', 'auto', 'pre_switch', 'pre_restore', 'pre_change', 'manual', 'imported')),
    label TEXT NOT NULL,
    library_enc BYTEA NOT NULL,
    addons_enc BYTEA NOT NULL,
    notifs_enc BYTEA,
    library_count INTEGER NOT NULL,
    addon_count INTEGER NOT NULL,
    notif_count INTEGER,
    stremio_user_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    content_hash TEXT,
    profile_id INTEGER REFERENCES profiles (id) ON DELETE SET NULL,
    edit_kind TEXT,
    undone_at BIGINT,
    after_hash TEXT,
    held_profile_id INTEGER REFERENCES profiles (id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS backups_account_kind_created ON backups (account_id, kind, created_at);

  CREATE TABLE IF NOT EXISTS switch_journal (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('switch', 'restore')),
    from_profile_id INTEGER REFERENCES profiles (id) ON DELETE SET NULL,
    to_profile_id INTEGER REFERENCES profiles (id) ON DELETE SET NULL,
    target_backup_id INTEGER REFERENCES backups (id) ON DELETE SET NULL,
    rollback_backup_id INTEGER REFERENCES backups (id) ON DELETE SET NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'finished', 'rolled_back')),
    started_at BIGINT NOT NULL,
    finished_at BIGINT,
    error TEXT,
    warnings TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS switch_journal_account_status ON switch_journal (account_id, status);

  CREATE TABLE IF NOT EXISTS sessions (
    id_hash BYTEA PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    flash TEXT,
    user_agent TEXT,
    created_at BIGINT NOT NULL,
    last_seen_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);

  CREATE TABLE IF NOT EXISTS activity (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    at BIGINT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS activity_account_at ON activity (account_id, at);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS carryovers (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    owner_profile_id INTEGER NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    item_enc BYTEA NOT NULL,
    created_at BIGINT NOT NULL,
    changed_at BIGINT,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS carryovers_account ON carryovers (account_id);

  INSERT INTO meta (key, value) VALUES ('schema_version', '1') ON CONFLICT (key) DO NOTHING;
  `,
];

/**
 * Open a connection pool to PostgreSQL and run migrations.
 * Returns a PgDatabase instance that wraps pg.Pool with a higher-level API.
 */
export async function openDatabase(connectionString, { maxRetries = 5, retryDelayMs = 2000 } = {}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required (the PostgreSQL connection string from Supabase)');
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  // Test connection with retries
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      break;
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(`Could not connect to PostgreSQL after ${maxRetries} attempts: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  const db = new PgDatabase(pool);
  await db.migrate();
  return db;
}

/**
 * A wrapper around pg.Pool that provides a convenient API for the OpenProfiles
 * codebase. Methods mirror the patterns used by the existing better-sqlite3 code
 * but are async.
 */
export class PgDatabase {
  constructor(pool) {
    this.pool = pool;
    this.name = 'postgresql';
  }

  /** Run a single query; returns { rows, rowCount, lastId }. */
  async query(text, params = []) {
    const result = await this.pool.query(text, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount,
      lastId: result.rows[0]?.id ?? null,
    };
  }

  /** Get a single row, or null. */
  async get(text, params = []) {
    const result = await this.pool.query(text, params);
    return result.rows[0] || null;
  }

  /** Get all matching rows. */
  async all(text, params = []) {
    const result = await this.pool.query(text, params);
    return result.rows;
  }

  /** Execute a statement (INSERT/UPDATE/DELETE) and return { changes, lastInsertRowid }. */
  async run(text, params = []) {
    const result = await this.pool.query(text, params);
    return {
      changes: result.rowCount,
      lastInsertRowid: result.rows?.[0]?.id ?? null,
    };
  }

  /**
   * Run a function inside a PostgreSQL transaction.
   * The function receives a client that must be used for all queries in the transaction.
   */
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txDb = new TxDatabase(client);
      const result = await fn(txDb);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async migrate() {
    // Create meta table if it doesn't exist (for tracking schema version)
    await this.pool.query(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const row = await this.get("SELECT value FROM meta WHERE key = 'schema_version'");
    const current = row ? parseInt(row.value, 10) : 0;

    for (let v = current; v < MIGRATIONS.length; v++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(MIGRATIONS[v]);
        await client.query(
          `INSERT INTO meta (key, value) VALUES ('schema_version', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1`,
          [String(v + 1)]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${v + 1} failed: ${err.message}`);
      } finally {
        client.release();
      }
    }
  }

  /** Check if the database connection is healthy. */
  async healthy() {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    await this.pool.end();
  }
}

/** A database wrapper that uses a transaction client instead of the pool. */
class TxDatabase {
  constructor(client) {
    this.client = client;
  }

  async query(text, params = []) {
    const result = await this.client.query(text, params);
    return { rows: result.rows, rowCount: result.rowCount, lastId: result.rows[0]?.id ?? null };
  }

  async get(text, params = []) {
    const result = await this.client.query(text, params);
    return result.rows[0] || null;
  }

  async all(text, params = []) {
    const result = await this.client.query(text, params);
    return result.rows;
  }

  async run(text, params = []) {
    const result = await this.client.query(text, params);
    return { changes: result.rowCount, lastInsertRowid: result.rows?.[0]?.id ?? null };
  }

  /** Support nested transactions by running with the existing transaction client. */
  async transaction(fn) {
    return await fn(this);
  }
}
