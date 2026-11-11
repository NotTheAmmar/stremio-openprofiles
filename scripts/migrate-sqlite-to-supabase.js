#!/usr/bin/env node

/**
 * OpenProfiles SQLite to Supabase PostgreSQL Migration Script
 *
 * Reads an existing SQLite database (default: /data/openprofiles.db or custom path)
 * and safely migrates all data into Supabase PostgreSQL.
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-supabase.js [--sqlite /path/to/openprofiles.db] [--pg "postgres://..."]
 *
 * Environment variables:
 *   SQLITE_PATH              - Path to SQLite file (default: /data/openprofiles.db, fallback: ./openprofiles.db)
 *   DATABASE_URL             - Supabase PostgreSQL connection string
 *   SUPABASE_DATABASE_URL    - Alternative environment variable for Supabase connection string
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db-pg.js';

// Parse CLI arguments
const args = process.argv.slice(2);
let sqlitePath = process.env.SQLITE_PATH;
let pgUrl = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sqlite' && args[i + 1]) {
    sqlitePath = args[++i];
  } else if (args[i] === '--pg' && args[i + 1]) {
    pgUrl = args[++i];
  }
}

// Fallback search paths for SQLite DB
if (!sqlitePath) {
  const candidates = [
    '/data/openprofiles.db',
    path.resolve(process.cwd(), 'data', 'openprofiles.db'),
    path.resolve(process.cwd(), 'openprofiles.db'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      sqlitePath = c;
      break;
    }
  }
}

if (!sqlitePath || !fs.existsSync(sqlitePath)) {
  console.error(`[ERROR] SQLite database file not found. Looked at: ${sqlitePath || 'default paths (/data/openprofiles.db, ./openprofiles.db)'}`);
  console.error('Specify the path with --sqlite <path> or SQLITE_PATH=<path>.');
  process.exit(1);
}

if (!pgUrl) {
  console.error('[ERROR] PostgreSQL connection string is required.');
  console.error('Specify with --pg <url> or DATABASE_URL=<url> / SUPABASE_DATABASE_URL=<url>.');
  process.exit(1);
}

console.log(`[INFO] Source SQLite: ${sqlitePath}`);
console.log(`[INFO] Target PostgreSQL: ${pgUrl.replace(/:([^@:]+)@/, ':****@')}`);

async function migrate() {
  console.log('[INFO] Opening SQLite database (read-only)...');
  const sqlite = new Database(sqlitePath, { readonly: true });

  console.log('[INFO] Connecting to Supabase PostgreSQL and initializing schema...');
  const pgDb = await openDatabase(pgUrl);

  // Check which tables exist in SQLite
  const tablesInSqlite = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  console.log(`[INFO] Tables found in SQLite: ${tablesInSqlite.join(', ')}`);

  // Count rows in SQLite
  const sqliteCounts = {};
  for (const t of tablesInSqlite) {
    const row = sqlite.prepare(`SELECT COUNT(*) as count FROM "${t}"`).get();
    sqliteCounts[t] = row.count;
  }
  console.log('[INFO] SQLite row counts:', sqliteCounts);

  await pgDb.transaction(async (tx) => {
    // 1. Migrate settings
    if (tablesInSqlite.includes('settings') && sqliteCounts.settings > 0) {
      console.log(`[INFO] Migrating ${sqliteCounts.settings} settings...`);
      const rows = sqlite.prepare('SELECT key, value, updated_at FROM settings').all();
      for (const r of rows) {
        await tx.run(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [r.key, r.value, r.updated_at]
        );
      }
    }

    // 2. Migrate accounts
    // We insert with active_profile_id = null first to break circular foreign keys, then update after profiles are inserted.
    const activeProfileMap = new Map();
    if (tablesInSqlite.includes('accounts') && sqliteCounts.accounts > 0) {
      console.log(`[INFO] Migrating ${sqliteCounts.accounts} accounts...`);
      const rows = sqlite.prepare('SELECT * FROM accounts').all();
      for (const r of rows) {
        activeProfileMap.set(r.id, r.active_profile_id);
        await tx.run(
          `INSERT INTO accounts (
             id, stremio_user_id, stremio_email, auth_key_enc, addon_token,
             active_profile_id, addon_installed, enc_version, created_at,
             last_login_at, notifs_foreign, last_addon_at, last_seen_at
           )
           VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO NOTHING`,
          [
            r.id,
            r.stremio_user_id,
            r.stremio_email,
            r.auth_key_enc,
            r.addon_token,
            r.addon_installed ?? null,
            r.enc_version ?? 2,
            r.created_at,
            r.last_login_at,
            r.notifs_foreign ?? 0,
            r.last_addon_at ?? null,
            r.last_seen_at ?? null,
          ]
        );
      }
    }

    // 3. Migrate profiles
    if (tablesInSqlite.includes('profiles') && sqliteCounts.profiles > 0) {
      console.log(`[INFO] Migrating ${sqliteCounts.profiles} profiles...`);
      const rows = sqlite.prepare('SELECT * FROM profiles').all();
      for (const r of rows) {
        await tx.run(
          `INSERT INTO profiles (
             id, account_id, name, avatar_preset, avatar_colour,
             library_enc, addons_enc, notifs_enc, library_count, addon_count,
             notif_count, snapshot_taken_at, stremio_user_id, created_at,
             deleted_at, photo_enc, photo_hash, passcode_hash
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           ON CONFLICT (id) DO NOTHING`,
          [
            r.id,
            r.account_id,
            r.name,
            r.avatar_preset,
            r.avatar_colour,
            r.library_enc,
            r.addons_enc,
            r.notifs_enc ?? null,
            r.library_count,
            r.addon_count,
            r.notif_count ?? null,
            r.snapshot_taken_at,
            r.stremio_user_id,
            r.created_at,
            r.deleted_at ?? null,
            r.photo_enc ?? null,
            r.photo_hash ?? null,
            r.passcode_hash ?? null,
          ]
        );
      }
    }

    // Restore active_profile_id on accounts now that profiles exist
    for (const [accountId, activeProfileId] of activeProfileMap.entries()) {
      if (activeProfileId) {
        await tx.run(
          'UPDATE accounts SET active_profile_id = $1 WHERE id = $2',
          [activeProfileId, accountId]
        );
      }
    }

    // 4. Migrate backups
    if (tablesInSqlite.includes('backups') && sqliteCounts.backups > 0) {
      console.log(`[INFO] Migrating ${sqliteCounts.backups} backups...`);
      const rows = sqlite.prepare('SELECT * FROM backups').all();
      for (const r of rows) {
        await tx.run(
          `INSERT INTO backups (
             id, account_id, kind, label, library_enc, addons_enc,
             notifs_enc, library_count, addon_count, notif_count,
             stremio_user_id, created_at, content_hash, profile_id,
             edit_kind, undone_at, after_hash, held_profile_id
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           ON CONFLICT (id) DO NOTHING`,
          [
            r.id,
            r.account_id,
            r.kind,
            r.label,
            r.library_enc,
            r.addons_enc,
            r.notifs_enc ?? null,
            r.library_count,
            r.addon_count,
            r.notif_count ?? null,
            r.stremio_user_id,
            r.created_at,
            r.content_hash ?? null,
            r.profile_id ?? null,
            r.edit_kind ?? null,
            r.undone_at ?? null,
            r.after_hash ?? null,
            r.held_profile_id ?? null,
          ]
        );
      }
    }

    // 5. Migrate switch_journal
    if (tablesInSqlite.includes('switch_journal') && sqliteCounts.switch_journal > 0) {
      console.log(`[INFO] Migrating ${sqliteCounts.switch_journal} switch_journal entries...`);
      const rows = sqlite.prepare('SELECT * FROM switch_journal').all();
      for (const r of rows) {
        await tx.run(
          `INSERT INTO switch_journal (
             id, account_id, kind, from_profile_id, to_profile_id,
             target_backup_id, rollback_backup_id, phase, status,
             started_at, finished_at, error, warnings
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO NOTHING`,
          [
            r.id,
            r.account_id,
            r.kind,
            r.from_profile_id ?? null,
            r.to_profile_id ?? null,
            r.target_backup_id ?? null,
            r.rollback_backup_id ?? null,
            r.phase,
            r.status,
            r.started_at,
            r.finished_at ?? null,
            r.error ?? null,
            r.warnings ?? '[]',
          ]
        );
      }
    }

    // 6. Migrate sessions
    if (tablesInSqlite.includes('sessions') && sqliteCounts.sessions > 0) {
      console.log(`[INFO] Migrating ${sqliteCounts.sessions} sessions...`);
      const rows = sqlite.prepare('SELECT * FROM sessions').all();
      for (const r of rows) {
        await tx.run(
          `INSERT INTO sessions (
             id_hash, account_id, csrf, flash, user_agent, created_at, last_seen_at, expires_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id_hash) DO NOTHING`,
          [
            r.id_hash,
            r.account_id,
            r.csrf,
            r.flash ?? null,
            r.user_agent ?? null,
            r.created_at,
            r.last_seen_at,
            r.expires_at,
          ]
        );
      }
    }

    // 7. Migrate activity
    if (tablesInSqlite.includes('activity') && sqliteCounts.activity > 0) {
      console.log(`[INFO] Migrating ${sqliteCounts.activity} activity records...`);
      const rows = sqlite.prepare('SELECT * FROM activity').all();
      for (const r of rows) {
        await tx.run(
          `INSERT INTO activity (id, account_id, at, kind, detail)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [r.id, r.account_id, r.at, r.kind, r.detail]
        );
      }
    }

    // 8. Migrate carryovers
    if (tablesInSqlite.includes('carryovers') && sqliteCounts.carryovers > 0) {
      console.log(`[INFO] Migrating ${sqliteCounts.carryovers} carryovers...`);
      const rows = sqlite.prepare('SELECT * FROM carryovers').all();
      for (const r of rows) {
        await tx.run(
          `INSERT INTO carryovers (id, account_id, owner_profile_id, item_enc, created_at, changed_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [
            r.id,
            r.account_id,
            r.owner_profile_id,
            r.item_enc,
            r.created_at,
            r.changed_at ?? null,
            r.expires_at ?? (r.created_at + 86400000 * 30),
          ]
        );
      }
    }

    // 9. Migrate meta
    if (tablesInSqlite.includes('meta') && sqliteCounts.meta > 0) {
      console.log(`[INFO] Migrating ${sqliteCounts.meta} meta records...`);
      const rows = sqlite.prepare('SELECT key, value FROM meta').all();
      for (const r of rows) {
        await tx.run(
          `INSERT INTO meta (key, value)
           VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [r.key, r.value]
        );
      }
    }

    // 10. Update PostgreSQL serial sequences to match the maximum IDs inserted
    console.log('[INFO] Updating PostgreSQL sequences...');
    const serialTables = ['accounts', 'profiles', 'backups', 'switch_journal', 'activity', 'carryovers'];
    for (const table of serialTables) {
      const maxRow = await tx.get(`SELECT COALESCE(MAX(id), 0) as max_id FROM "${table}"`);
      const maxId = Number(maxRow?.max_id || 0);
      if (maxId > 0) {
        await tx.run(`SELECT setval(pg_get_serial_sequence($1, 'id'), $2, true)`, [table, maxId]);
        console.log(`[INFO] Sequence for ${table} set to ${maxId}`);
      }
    }
  });

  // Verification step
  console.log('\n[INFO] Validating record counts in PostgreSQL:');
  const targetTables = ['accounts', 'profiles', 'backups', 'switch_journal', 'sessions', 'activity', 'settings', 'carryovers', 'meta'];
  for (const t of targetTables) {
    const res = await pgDb.get(`SELECT COUNT(*) as count FROM "${t}"`);
    const pgCount = Number(res?.count || 0);
    const sqlCount = sqliteCounts[t] ?? 0;
    console.log(`  - Table "${t}": SQLite = ${sqlCount}, PostgreSQL = ${pgCount}`);
    if (sqlCount > 0 && pgCount < sqlCount) {
      console.warn(`[WARN] Table ${t} has fewer records in PostgreSQL (${pgCount}) than SQLite (${sqlCount})!`);
    }
  }

  sqlite.close();
  await pgDb.close();
  console.log('\n[SUCCESS] Migration completed successfully! SQLite database has been preserved untouched.');
}

migrate().catch((err) => {
  console.error('\n[FATAL] Migration failed:', err);
  process.exit(1);
});
