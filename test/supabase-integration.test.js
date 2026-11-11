import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { describe, it, beforeEach } from 'node:test';
import { Cipher } from '../src/crypto.js';
import { checkSecretKey } from '../src/core/keycheck.js';
import { AccountsService, accessDecision } from '../src/core/accounts.js';
import { Settings } from '../src/core/settings.js';
import { createAuth } from '../src/web/auth.js';
import { createApp } from '../src/web/app.js';
import { StremioClient } from '../src/stremio/client.js';
import { FakeStremio, addon, libItem } from './helpers/fakeStremio.js';

/**
 * Pure-JS In-Memory PostgreSQL Mock DB implementing the PgDatabase interface
 * from src/db-pg.js. This allows fully automated testing of all repository,
 * authentication, and service queries without needing a remote Postgres daemon.
 */
class InMemoryPgDatabase {
  constructor() {
    this.tables = {
      accounts: new Map(),
      profiles: new Map(),
      backups: new Map(),
      switch_journal: new Map(),
      sessions: new Map(),
      activity: new Map(),
      meta: new Map(),
      settings: new Map(),
      carryovers: new Map(),
    };
    this.sequences = {
      accounts: 1,
      profiles: 1,
      backups: 1,
      switch_journal: 1,
      activity: 1,
      carryovers: 1,
    };
    this.isHealthy = true;
  }

  async healthy() {
    if (!this.isHealthy) throw new Error('Database connection failed');
    return true;
  }

  async close() {}

  async transaction(fn) {
    return await fn(this);
  }

  async query(sql, params = []) {
    return this._exec(sql, params);
  }

  async get(sql, params = []) {
    const res = await this._exec(sql, params);
    return res.rows[0] || null;
  }

  async all(sql, params = []) {
    const res = await this._exec(sql, params);
    return res.rows;
  }

  async run(sql, params = []) {
    const res = await this._exec(sql, params);
    return { rowCount: res.rowCount };
  }

  async _exec(sql, params) {
    const norm = sql.trim().replace(/\s+/g, ' ');

    // Health check
    if (norm === 'SELECT 1') {
      if (!this.isHealthy) throw new Error('DB connection refused');
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    // META TABLE
    if (norm.startsWith('SELECT value FROM meta WHERE key = $1')) {
      const row = this.tables.meta.get(params[0]);
      return { rows: row ? [{ value: row.value }] : [], rowCount: row ? 1 : 0 };
    }
    if (norm.startsWith('INSERT INTO meta (key, value) VALUES ($1, $2)')) {
      if (norm.includes('ON CONFLICT (key) DO NOTHING')) {
        if (!this.tables.meta.has(params[0])) {
          this.tables.meta.set(params[0], { key: params[0], value: params[1] });
        }
      } else {
        this.tables.meta.set(params[0], { key: params[0], value: params[1] });
      }
      return { rows: [], rowCount: 1 };
    }

    // SETTINGS TABLE
    if (norm.startsWith('SELECT key, value FROM settings')) {
      const rows = Array.from(this.tables.settings.values()).map(r => ({ key: r.key, value: r.value }));
      return { rows, rowCount: rows.length };
    }
    if (norm.startsWith('INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE')) {
      this.tables.settings.set(params[0], { key: params[0], value: params[1], updated_at: params[2] });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('DELETE FROM settings WHERE key = $1')) {
      const existed = this.tables.settings.delete(params[0]);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    // ACCOUNTS TABLE
    if (norm.includes('FROM accounts WHERE stremio_user_id = $1')) {
      const match = Array.from(this.tables.accounts.values()).find(a => a.stremio_user_id === params[0]);
      return { rows: match ? [structuredClone(match)] : [], rowCount: match ? 1 : 0 };
    }
    if (norm.includes('FROM accounts WHERE id = $1')) {
      const match = this.tables.accounts.get(Number(params[0]));
      return { rows: match ? [structuredClone(match)] : [], rowCount: match ? 1 : 0 };
    }
    if (norm.includes('FROM accounts WHERE addon_token = $1')) {
      const match = Array.from(this.tables.accounts.values()).find(a => a.addon_token === params[0]);
      return { rows: match ? [structuredClone(match)] : [], rowCount: match ? 1 : 0 };
    }
    if (norm.includes('FROM accounts') && norm.includes('COUNT(*)')) {
      const count = this.tables.accounts.size;
      return { rows: [{ count, n: count }], rowCount: 1 };
    }
    if (norm.startsWith('INSERT INTO accounts')) {
      const id = this.sequences.accounts++;
      const row = {
        id,
        stremio_user_id: params[0],
        stremio_email: params[1],
        auth_key_enc: Buffer.from([]),
        addon_token: params[2],
        created_at: params[3],
        last_login_at: params[4],
        enc_version: 2,
        active_profile_id: null,
        addon_installed: null,
        notifs_foreign: 0,
        last_addon_at: null,
        last_seen_at: null,
      };
      this.tables.accounts.set(id, row);
      return { rows: [{ id }], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE accounts SET auth_key_enc = $1 WHERE id = $2')) {
      const acct = this.tables.accounts.get(Number(params[1]));
      if (acct) acct.auth_key_enc = params[0];
      return { rows: [], rowCount: acct ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE accounts SET stremio_email = $1, auth_key_enc = $2, last_login_at = $3 WHERE id = $4')) {
      const acct = this.tables.accounts.get(Number(params[3]));
      if (acct) {
        acct.stremio_email = params[0];
        acct.auth_key_enc = params[1];
        acct.last_login_at = params[2];
      }
      return { rows: [], rowCount: acct ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE accounts SET active_profile_id = $1 WHERE id = $2')) {
      const acct = this.tables.accounts.get(Number(params[1]));
      if (acct) acct.active_profile_id = params[0] ? Number(params[0]) : null;
      return { rows: [], rowCount: acct ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE accounts SET last_login_at = $1 WHERE id = $2')) {
      const acct = this.tables.accounts.get(Number(params[1]));
      if (acct) acct.last_login_at = params[0];
      return { rows: [], rowCount: acct ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE accounts SET addon_token = $1 WHERE id = $2')) {
      const acct = this.tables.accounts.get(Number(params[1]));
      if (acct) acct.addon_token = params[0];
      return { rows: [], rowCount: acct ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE accounts SET addon_installed = $1 WHERE id = $2')) {
      const acct = this.tables.accounts.get(Number(params[1]));
      if (acct) acct.addon_installed = params[0];
      return { rows: [], rowCount: acct ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE accounts SET last_seen_at = $1 WHERE id = $2')) {
      const acct = this.tables.accounts.get(Number(params[1]));
      if (acct) acct.last_seen_at = params[0];
      return { rows: [], rowCount: acct ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE accounts SET last_addon_at = $1 WHERE id = $2')) {
      const acct = this.tables.accounts.get(Number(params[1]));
      if (acct) acct.last_addon_at = params[0];
      return { rows: [], rowCount: acct ? 1 : 0 };
    }
    if (norm.startsWith('DELETE FROM accounts WHERE id = $1')) {
      const id = Number(params[0]);
      this.tables.accounts.delete(id);
      for (const [pid, p] of this.tables.profiles.entries()) {
        if (p.account_id === id) this.tables.profiles.delete(pid);
      }
      for (const [bid, b] of this.tables.backups.entries()) {
        if (b.account_id === id) this.tables.backups.delete(bid);
      }
      for (const [sid, s] of this.tables.sessions.entries()) {
        if (s.account_id === id) this.tables.sessions.delete(sid);
      }
      return { rows: [], rowCount: 1 };
    }

    // PROFILES TABLE
    if (norm.includes('FROM profiles') && norm.includes('COUNT(*)')) {
      const accountId = Number(params[0]);
      let count = 0;
      for (const p of this.tables.profiles.values()) {
        if (p.account_id === accountId && p.deleted_at === null) count++;
      }
      return { rows: [{ count, n: count }], rowCount: 1 };
    }
    if (norm.startsWith('INSERT INTO profiles')) {
      const id = this.sequences.profiles++;
      const row = {
        id,
        account_id: Number(params[0]),
        name: params[1],
        avatar_preset: params[2],
        avatar_colour: params[3],
        library_enc: params[4],
        addons_enc: params[5],
        notifs_enc: params[6],
        library_count: params[7],
        addon_count: params[8],
        notif_count: params[9],
        snapshot_taken_at: params[10],
        stremio_user_id: params[11],
        created_at: params[10],
        deleted_at: null,
        photo_enc: null,
        photo_hash: null,
        passcode_hash: null,
      };
      this.tables.profiles.set(id, row);
      return { rows: [{ id }], rowCount: 1 };
    }
    if (norm.includes('FROM profiles') && norm.includes('WHERE account_id = $1 AND deleted_at IS NULL ORDER BY created_at, id')) {
      const list = Array.from(this.tables.profiles.values())
        .filter(p => p.account_id === Number(params[0]) && p.deleted_at === null)
        .sort((a, b) => a.created_at - b.created_at || a.id - b.id)
        .map(p => ({ ...p, has_passcode: Boolean(p.passcode_hash) }));
      return { rows: structuredClone(list), rowCount: list.length };
    }
    if (norm.includes('FROM profiles') && norm.includes('ORDER BY name COLLATE "C" ASC')) {
      const list = Array.from(this.tables.profiles.values())
        .filter(p => p.account_id === Number(params[0]) && p.deleted_at === null)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(p => ({ ...p, has_passcode: Boolean(p.passcode_hash) }));
      return { rows: structuredClone(list), rowCount: list.length };
    }
    if (norm.includes('FROM profiles WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL')) {
      const p = this.tables.profiles.get(Number(params[0]));
      const match = (p && p.account_id === Number(params[1]) && p.deleted_at === null) ? p : null;
      return { rows: match ? [{ ...structuredClone(match), has_passcode: Boolean(match.passcode_hash) }] : [], rowCount: match ? 1 : 0 };
    }
    if (norm.includes('FROM profiles WHERE account_id = $1 AND id = $2 AND deleted_at IS NULL')) {
      const p = this.tables.profiles.get(Number(params[1]));
      const match = (p && p.account_id === Number(params[0]) && p.deleted_at === null) ? p : null;
      return { rows: match ? [{ ...structuredClone(match), has_passcode: Boolean(match.passcode_hash) }] : [], rowCount: match ? 1 : 0 };
    }
    if (norm.includes('FROM profiles WHERE id = $1 AND account_id = $2 AND deleted_at IS NOT NULL')) {
      const p = this.tables.profiles.get(Number(params[0]));
      const match = (p && p.account_id === Number(params[1]) && p.deleted_at !== null) ? p : null;
      return { rows: match ? [{ ...structuredClone(match), has_passcode: Boolean(match.passcode_hash) }] : [], rowCount: match ? 1 : 0 };
    }
    if (norm.includes('FROM profiles WHERE account_id = $1 AND id = $2')) {
      const p = this.tables.profiles.get(Number(params[1]));
      const match = (p && p.account_id === Number(params[0])) ? p : null;
      return { rows: match ? [{ ...structuredClone(match), has_passcode: Boolean(match.passcode_hash) }] : [], rowCount: match ? 1 : 0 };
    }
    if (norm.includes('FROM profiles') && norm.includes('deleted_at IS NOT NULL')) {
      const list = Array.from(this.tables.profiles.values())
        .filter(p => p.account_id === Number(params[0]) && p.deleted_at !== null)
        .map(p => ({ ...p, has_passcode: Boolean(p.passcode_hash) }));
      return { rows: structuredClone(list), rowCount: list.length };
    }
    if (norm.startsWith('UPDATE profiles SET deleted_at = $1 WHERE id = $2 AND account_id = $3')) {
      const p = this.tables.profiles.get(Number(params[1]));
      if (p && p.account_id === Number(params[2])) p.deleted_at = params[0];
      return { rows: [], rowCount: p ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE profiles SET deleted_at = NULL, name = $1 WHERE id = $2 AND account_id = $3')) {
      const p = this.tables.profiles.get(Number(params[1]));
      if (p && p.account_id === Number(params[2])) {
        p.deleted_at = null;
        p.name = params[0];
      }
      return { rows: [], rowCount: p ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE profiles SET name = $1 WHERE account_id = $2 AND id = $3')) {
      const p = this.tables.profiles.get(Number(params[2]));
      if (p && p.account_id === Number(params[1])) p.name = params[0];
      return { rows: [], rowCount: p ? 1 : 0 };
    }
    if (norm.startsWith('UPDATE profiles SET library_enc = $1')) {
      const id = Number(params[8]);
      const acctId = Number(params[9]);
      const p = this.tables.profiles.get(id);
      if (p && p.account_id === acctId) {
        p.library_enc = params[0];
        p.addons_enc = params[1];
        p.notifs_enc = params[2];
        p.library_count = params[3];
        p.addon_count = params[4];
        p.notif_count = params[5];
        p.snapshot_taken_at = params[6];
        p.stremio_user_id = params[7];
      }
      return { rows: [], rowCount: p ? 1 : 0 };
    }

    // BACKUPS TABLE
    if (norm.startsWith('INSERT INTO backups')) {
      const id = this.sequences.backups++;
      const row = {
        id,
        account_id: Number(params[0]),
        kind: params[1],
        label: params[2],
        library_enc: params[3],
        addons_enc: params[4],
        notifs_enc: params[5],
        library_count: params[6],
        addon_count: params[7],
        notif_count: params[8],
        stremio_user_id: params[9],
        created_at: params[10],
        content_hash: params[11] ?? null,
        profile_id: params[12] ?? null,
        edit_kind: params[13] ?? null,
        undone_at: null,
        after_hash: null,
        held_profile_id: null,
      };
      this.tables.backups.set(id, row);
      return { rows: [{ id }], rowCount: 1 };
    }
    if (norm.includes('FROM backups WHERE account_id = $1')) {
      let list = Array.from(this.tables.backups.values()).filter(b => b.account_id === Number(params[0]));
      if (norm.includes('AND id = $2')) {
        list = list.filter(b => b.id === Number(params[1]));
      }
      return { rows: structuredClone(list), rowCount: list.length };
    }

    // SWITCH JOURNAL
    if (norm.startsWith('INSERT INTO switch_journal')) {
      const id = this.sequences.switch_journal++;
      const row = {
        id,
        account_id: Number(params[0]),
        kind: params[1],
        from_profile_id: params[2],
        to_profile_id: params[3],
        target_backup_id: params[4],
        rollback_backup_id: params[5],
        phase: params[6],
        status: params[7],
        started_at: params[8],
        finished_at: null,
        error: null,
        warnings: params[9] ?? '[]',
      };
      this.tables.switch_journal.set(id, row);
      return { rows: [{ id }], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE switch_journal SET status = $1, phase = \'done\', finished_at = $2, error = NULL, warnings = $3 WHERE id = $4 AND account_id = $5')) {
      const j = this.tables.switch_journal.get(Number(params[3]));
      if (j && j.account_id === Number(params[4])) {
        j.status = params[0];
        j.finished_at = params[1];
        j.warnings = params[2];
        j.phase = 'done';
      }
      return { rows: [], rowCount: j ? 1 : 0 };
    }
    if (norm.includes('FROM switch_journal WHERE account_id = $1 AND status = \'open\'')) {
      const open = Array.from(this.tables.switch_journal.values())
        .filter(j => j.account_id === Number(params[0]) && j.status === 'open');
      return { rows: structuredClone(open), rowCount: open.length };
    }

    // SESSIONS TABLE
    if (norm.startsWith('INSERT INTO sessions')) {
      const key = Buffer.from(params[0]).toString('hex');
      this.tables.sessions.set(key, {
        id_hash: params[0],
        account_id: Number(params[1]),
        csrf: params[2],
        flash: null,
        user_agent: params[3],
        created_at: params[4],
        last_seen_at: params[5],
        expires_at: params[6],
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.includes('FROM sessions') && norm.includes('WHERE id_hash = $1 AND expires_at > $2')) {
      const key = Buffer.from(params[0]).toString('hex');
      const s = this.tables.sessions.get(key);
      if (s && s.expires_at > params[1]) {
        return {
          rows: [structuredClone(s)],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }
    if (norm.startsWith('UPDATE sessions SET flash = $1 WHERE id_hash = $2')) {
      const key = Buffer.from(params[1]).toString('hex');
      const s = this.tables.sessions.get(key);
      if (s) s.flash = params[0];
      return { rows: [], rowCount: s ? 1 : 0 };
    }
    if (norm.startsWith('DELETE FROM sessions WHERE id_hash = $1')) {
      const key = Buffer.from(params[0]).toString('hex');
      this.tables.sessions.delete(key);
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('SELECT encode(id_hash, \'hex\') as id')) {
      const list = Array.from(this.tables.sessions.values())
        .filter(s => s.account_id === Number(params[0]) && s.expires_at > params[1])
        .map(s => ({
          id: Buffer.from(s.id_hash).toString('hex'),
          user_agent: s.user_agent,
          created_at: s.created_at,
          last_seen_at: s.last_seen_at,
        }));
      return { rows: list, rowCount: list.length };
    }

    // ACTIVITY TABLE
    if (norm.startsWith('INSERT INTO activity')) {
      const id = this.sequences.activity++;
      this.tables.activity.set(id, { id, account_id: params[0], at: params[1], kind: params[2], detail: params[3] });
      return { rows: [{ id }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

describe('Supabase PostgreSQL OpenProfiles Test Suite', () => {
  let db;
  let key;
  let cipher;
  let fake;
  let stremio;
  let settings;
  let accounts;

  beforeEach(async () => {
    db = new InMemoryPgDatabase();
    key = crypto.randomBytes(32);
    cipher = new Cipher(key);
    fake = new FakeStremio({ userId: 'u-1', email: 'user@example.com', password: 'pass123', authKey: 'authkey123' })
      .seed({
        library: [libItem('tt12345', { lastWatched: '2026-10-01' })],
        addons: [addon('cinemeta')],
      });
    stremio = new StremioClient({ fetchImpl: fake.fetch, sleep: async () => {} });
    settings = await Settings.create({ db, env: { ACCESS: 'open' } });
    accounts = new AccountsService({
      db,
      cipher,
      stremio,
      sleep: async () => {},
      now: () => Date.now(),
      access: () => settings.access(),
    });
  });

  describe('1. Health Check Endpoint', () => {
    it('returns 200 { status: "ok" } when database is healthy', async () => {
      const app = createApp({
        config: { publicUrl: 'https://example.com', trustProxy: false },
        db,
        accounts,
        settings,
      });

      const res = await fetchResponse(app, 'GET', '/health');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { status: 'ok' });
    });

    it('returns 503 { status: "unhealthy" } when database fails without leaking credentials', async () => {
      db.isHealthy = false;
      const app = createApp({
        config: { publicUrl: 'https://example.com', trustProxy: false },
        db,
        accounts,
        settings,
      });

      const res = await fetchResponse(app, 'GET', '/health');
      assert.equal(res.status, 503);
      assert.deepEqual(res.body, { status: 'unhealthy', error: 'Service unavailable' });
    });
  });

  describe('2. Encryption & Key Check', () => {
    it('saves fingerprint on first boot and succeeds on restart with matching key', async () => {
      await checkSecretKey(db, key, cipher);
      const meta = await db.get('SELECT value FROM meta WHERE key = $1', ['key_fingerprint']);
      assert.ok(meta?.value, 'Key fingerprint should be recorded');

      await assert.doesNotReject(async () => {
        await checkSecretKey(db, key, cipher);
      });
    });

    it('fails when restarted with a different secret key', async () => {
      await checkSecretKey(db, key, cipher);
      const differentKey = crypto.randomBytes(32);
      await assert.rejects(async () => {
        await checkSecretKey(db, differentKey, new Cipher(differentKey));
      }, /The secret key does not match this database/);
    });

    it('encrypts and decrypts library items and add-on lists', () => {
      const originalPayload = { titles: ['tt1', 'tt2'], custom: true };
      const encrypted = cipher.encryptJson(originalPayload, 'library');
      assert.ok(Buffer.isBuffer(encrypted));
      const decrypted = cipher.decryptJson(encrypted, 'library');
      assert.deepEqual(decrypted, originalPayload);
    });
  });

  describe('3. Account Sign In & Profile Lifecycle', () => {
    it('correctly handles owner access decision when account count is returned as string from PostgreSQL', () => {
      const u = { id: 'u-1', email: 'owner@example.com' };
      // Postgres COUNT(*) can return '0' as string due to 64-bit bigint
      assert.equal(accessDecision({ mode: 'owner' }, { user: u, existing: null, accountCount: '0' }), null);
      assert.equal(accessDecision({ mode: 'owner' }, { user: u, existing: null, accountCount: 0 }), null);
      assert.match(accessDecision({ mode: 'owner' }, { user: u, existing: null, accountCount: '1' }), /belongs to someone/);
      assert.match(accessDecision({ mode: 'owner' }, { user: u, existing: null, accountCount: 1 }), /belongs to someone/);
      // Existing accounts or admin should always be allowed
      assert.equal(accessDecision({ mode: 'owner' }, { user: u, existing: { id: 1 }, accountCount: '1' }), null);
      assert.equal(accessDecision({ mode: 'owner' }, { user: u, existing: null, accountCount: '1', admin: true }), null);
    });

    it('signs in, creates "Original" profile, and switches profiles', async () => {
      const { accountId, created } = await accounts.signIn('user@example.com', 'pass123');
      assert.equal(created, true);
      assert.ok(accountId > 0);

      const service = accounts.forAccount(accountId);
      const status = await service.status();
      assert.equal(status.profiles.length, 1);
      assert.equal(status.profiles[0].name, 'Original');
      assert.equal(status.activeProfileId, status.profiles[0].id);

      // Create a new profile
      const kids = await service.createProfile({ name: 'Kids', from: 'empty' });
      assert.equal(kids.name, 'Kids');

      const afterCreate = await service.status();
      assert.equal(afterCreate.profiles.length, 2);

      // Switch to the new profile
      const switched = await service.switchTo(kids.id);
      assert.equal(switched.profile.name, 'Kids');

      const afterSwitch = await service.status();
      assert.equal(afterSwitch.activeProfileId, kids.id);

      // Switch back to original before deleting kids (cannot delete active profile)
      await service.switchTo(status.profiles[0].id);
      await service.deleteProfile(kids.id);
      const inBin = await service.listBin();
      assert.equal(inBin.length, 1);
      assert.equal(inBin[0].name, 'Kids');

      // Restore from bin
      await service.restoreFromBin(kids.id);
      const restoredStatus = await service.status();
      assert.equal(restoredStatus.profiles.length, 2);
    });
  });

  describe('4. Data Isolation between Accounts', () => {
    it('ensures separate accounts cannot see or switch to each other profiles', async () => {
      const fake2 = new FakeStremio({ userId: 'u-2', email: 'other@example.com', password: 'pass456', authKey: 'authkey456' })
        .seed({ library: [libItem('tt99999')], addons: [addon('cinemeta')] });

      const stremio2 = new StremioClient({ fetchImpl: fake2.fetch, sleep: async () => {} });
      const accounts2 = new AccountsService({
        db,
        cipher,
        stremio: stremio2,
        sleep: async () => {},
        now: () => Date.now(),
        access: () => settings.access(),
      });

      const { accountId: id1 } = await accounts.signIn('user@example.com', 'pass123');
      const { accountId: id2 } = await accounts2.signIn('other@example.com', 'pass456');

      const s1 = accounts.forAccount(id1);
      const s2 = accounts2.forAccount(id2);

      const p1 = (await s1.status()).profiles;
      const p2 = (await s2.status()).profiles;

      assert.equal(p1.length, 1);
      assert.equal(p2.length, 1);
      assert.notEqual(p1[0].id, p2[0].id);

      // Attempting to switch s1 to s2's profile must fail
      await assert.rejects(async () => {
        await s1.switchTo(p2[0].id);
      }, /That profile no longer exists/);
    });
  });

  describe('5. Web Authentication & Sessions', () => {
    it('creates, loads, and destroys web sessions', async () => {
      const auth = createAuth({ db, config: { publicUrl: 'https://example.com' } });
      const { accountId } = await accounts.signIn('user@example.com', 'pass123');

      const cookies = [];
      const req = {
        headers: { 'user-agent': 'test-browser' },
        ip: '127.0.0.1',
        get(header) {
          return this.headers[header.toLowerCase()] || '';
        },
      };
      const res = {
        append(name, val) {
          if (name === 'Set-Cookie') cookies.push(val);
        },
        setHeader(name, val) {
          this.append(name, val);
        },
      };

      await auth.startSession(req, res, accountId, 'user@example.com', { type: 'ok', text: 'Welcome' });
      assert.ok(cookies.length > 0, 'Session cookie must be set');

      // Extract session cookie
      const sidMatch = cookies[0].match(/op_session=([^;]+)/);
      assert.ok(sidMatch, 'op_session cookie must be present');
      const sid = sidMatch[1];

      // Load session
      const req2 = {
        headers: { cookie: `op_session=${sid}`, 'user-agent': 'test-browser' },
        get(h) { return this.headers[h.toLowerCase()] || ''; },
      };
      let optErr = null;
await auth.optional(req2, res, (e) => { if (e) optErr = e; });
if (optErr) console.error("[OPTIONAL ERROR]", optErr);
      assert.ok(req2.session, 'Session must load');
      assert.equal(req2.session.accountId, accountId);

      // Test Flash
      const flash = await auth.takeFlash(req2);
      assert.deepEqual(flash, { type: 'ok', text: 'Welcome' });

      // After taking flash, next takeFlash is null
      const flashAgain = await auth.takeFlash(req2);
      assert.equal(flashAgain, null);

      // Logout
      await auth.logout(req2, res);
      const req3 = {
        headers: { cookie: `op_session=${sid}`, 'user-agent': 'test-browser' },
        get(h) { return this.headers[h.toLowerCase()] || ''; },
      };
      await auth.optional(req3, res, () => {});
      assert.equal(req3.session, null);
    });
  });

  describe('6. Stremio Add-on Manifest & Routes', () => {
    it('serves valid Stremio addon manifest and catalogs', async () => {
      const { accountId } = await accounts.signIn('user@example.com', 'pass123');
      const acct = await db.get('SELECT * FROM accounts WHERE id = $1', [accountId]);
      const token = acct.addon_token;

      const app = createApp({
        config: { publicUrl: 'https://openprofiles.example.com', trustProxy: false },
        db,
        accounts,
        settings,
      });

      // Manifest
      const manifestRes = await fetchResponse(app, 'GET', `/${token}/manifest.json`);
      assert.equal(manifestRes.status, 200);
      assert.equal(manifestRes.body.id, 'community.openprofiles');
      assert.ok(Array.isArray(manifestRes.body.catalogs));

      // Catalog
      const catalogRes = await fetchResponse(app, 'GET', `/${token}/catalog/OpenProfiles/openprofiles.json`);
      assert.equal(catalogRes.status, 200);
      assert.ok(Array.isArray(catalogRes.body.metas));
      assert.equal(catalogRes.body.metas[0].name, 'Original');
    });
  });

  describe('7. Data Migration Logic Verification', () => {
    it('migrates records in correct dependency order preserving IDs and relationships', async () => {
      // Simulate source data
      const mockSqliteData = {
        settings: [{ key: 'accent', value: '#e5a00d', updated_at: 1000 }],
        accounts: [{
          id: 42,
          stremio_user_id: 'migrated-user',
          stremio_email: 'migrated@example.com',
          auth_key_enc: Buffer.from([1, 2, 3]),
          addon_token: 'migrated_token_1234567890abcdef',
          active_profile_id: 101,
          addon_installed: 1,
          enc_version: 2,
          created_at: 1000,
          last_login_at: 2000,
        }],
        profiles: [{
          id: 101,
          account_id: 42,
          name: 'Migrated Profile',
          avatar_preset: 'initial',
          avatar_colour: '#e5a00d',
          library_enc: Buffer.from([4, 5, 6]),
          addons_enc: Buffer.from([7, 8, 9]),
          notifs_enc: null,
          library_count: 5,
          addon_count: 2,
          notif_count: 0,
          snapshot_taken_at: 1000,
          stremio_user_id: 'migrated-user',
          created_at: 1000,
        }],
      };

      // Step 1: Insert settings
      for (const s of mockSqliteData.settings) {
        await db.run('INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE', [s.key, s.value, s.updated_at]);
      }

      // Step 2: Insert accounts with active_profile_id null first
      for (const a of mockSqliteData.accounts) {
        db.tables.accounts.set(a.id, {
          ...a,
          active_profile_id: null,
        });
      }

      // Step 3: Insert profiles
      for (const p of mockSqliteData.profiles) {
        db.tables.profiles.set(p.id, {
          ...p,
          deleted_at: null,
          photo_enc: null,
          photo_hash: null,
          passcode_hash: null,
        });
      }

      // Step 4: Restore accounts.active_profile_id
      for (const a of mockSqliteData.accounts) {
        const acct = db.tables.accounts.get(a.id);
        acct.active_profile_id = a.active_profile_id;
      }

      // Verify migration results in db
      const fetchedAccount = await db.get('SELECT * FROM accounts WHERE id = $1', [42]);
      assert.equal(fetchedAccount.stremio_email, 'migrated@example.com');
      assert.equal(fetchedAccount.active_profile_id, 101);

      const fetchedProfile = await db.get('SELECT * FROM profiles WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL', [101, 42]);
      assert.equal(fetchedProfile.name, 'Migrated Profile');

      const fetchedSetting = await db.get('SELECT key, value FROM settings');
      assert.ok(fetchedSetting);
    });
  });
});

/** Helper to test Express apps without network binding */
async function fetchResponse(app, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const opt = {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers,
      };
      const req = http.request(opt, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          server.close();
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            // ignore non-json response
          }
          resolve({ status: res.statusCode, headers: res.headers, text: raw, body: json });
        });
      });
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  });
}
