import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { describe, it, before, after } from 'node:test';
import { Cipher } from '../src/crypto.js';
import { AccountsService } from '../src/core/accounts.js';
import { Settings } from '../src/core/settings.js';
import { createApp } from '../src/web/app.js';
import { StremioClient } from '../src/stremio/client.js';
import { FakeStremio, addon, libItem } from './helpers/fakeStremio.js';

class FullMockPgDatabase {
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
    if (!this.isHealthy) throw new Error('Database offline');
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
    return { rowCount: res.rowCount, changes: res.rowCount };
  }

  async _exec(sql, params) {
    const norm = sql.trim().replace(/\s+/g, ' ');

    if (norm === 'SELECT 1') {
      if (!this.isHealthy) throw new Error('DB connection refused');
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    if (norm.startsWith('SELECT value FROM meta WHERE key = $1')) {
      const row = this.tables.meta.get(params[0]);
      return { rows: row ? [{ value: row.value }] : [], rowCount: row ? 1 : 0 };
    }
    if (norm.startsWith('INSERT INTO meta (key, value) VALUES ($1, $2)')) {
      this.tables.meta.set(params[0], { key: params[0], value: params[1] });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('SELECT key, value FROM settings')) {
      const rows = Array.from(this.tables.settings.values()).map((r) => ({ key: r.key, value: r.value }));
      return { rows, rowCount: rows.length };
    }
    if (norm.startsWith('INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE')) {
      this.tables.settings.set(params[0], { key: params[0], value: params[1], updated_at: params[2] });
      return { rows: [], rowCount: 1 };
    }

    if (norm.includes('FROM accounts') && norm.includes('COUNT(*)')) {
      const count = this.tables.accounts.size;
      return { rows: [{ count, n: count }], rowCount: 1 };
    }
    if (norm.includes('FROM accounts WHERE id = $1')) {
      const match = this.tables.accounts.get(Number(params[0]));
      return { rows: match ? [structuredClone(match)] : [], rowCount: match ? 1 : 0 };
    }
    if (norm.includes('FROM accounts WHERE stremio_user_id = $1')) {
      const match = Array.from(this.tables.accounts.values()).find((a) => a.stremio_user_id === params[0]);
      return { rows: match ? [structuredClone(match)] : [], rowCount: match ? 1 : 0 };
    }
    if (norm.includes('FROM accounts WHERE addon_token = $1')) {
      const match = Array.from(this.tables.accounts.values()).find((a) => a.addon_token === params[0]);
      return { rows: match ? [structuredClone(match)] : [], rowCount: match ? 1 : 0 };
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
    if (norm.includes('FROM profiles') && norm.includes('deleted_at IS NULL')) {
      const accountId = Number(params[0]);
      const list = Array.from(this.tables.profiles.values())
        .filter((p) => p.account_id === accountId && p.deleted_at === null)
        .map((p) => ({ ...p, has_passcode: Boolean(p.passcode_hash) }));
      return { rows: structuredClone(list), rowCount: list.length };
    }
    if (norm.includes('FROM profiles WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL')) {
      const p = this.tables.profiles.get(Number(params[0]));
      const match = p && p.account_id === Number(params[1]) && p.deleted_at === null ? p : null;
      return { rows: match ? [{ ...structuredClone(match), has_passcode: Boolean(match.passcode_hash) }] : [], rowCount: match ? 1 : 0 };
    }
    if (norm.includes('FROM profiles WHERE account_id = $1 AND id = $2 AND deleted_at IS NULL')) {
      const p = this.tables.profiles.get(Number(params[1]));
      const match = p && p.account_id === Number(params[0]) && p.deleted_at === null ? p : null;
      return { rows: match ? [{ ...structuredClone(match), has_passcode: Boolean(match.passcode_hash) }] : [], rowCount: match ? 1 : 0 };
    }

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
      const list = Array.from(this.tables.backups.values()).filter((b) => b.account_id === Number(params[0]));
      return { rows: structuredClone(list), rowCount: list.length };
    }

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
    if (norm.includes('FROM switch_journal WHERE account_id = $1 AND status = \'open\'')) {
      return { rows: [], rowCount: 0 };
    }
    if (norm.includes('FROM switch_journal WHERE status = \'open\'')) {
      return { rows: [], rowCount: 0 };
    }

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
        return { rows: [structuredClone(s)], rowCount: 1 };
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
    if (norm.startsWith('DELETE FROM sessions WHERE expires_at <= $1')) {
      return { rows: [], rowCount: 0 };
    }

    if (norm.startsWith('INSERT INTO activity')) {
      const id = this.sequences.activity++;
      this.tables.activity.set(id, { id, account_id: params[0], at: params[1], kind: params[2], detail: params[3] });
      return { rows: [{ id }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

describe('End-to-End Server & Stremio Add-on Verification', () => {
  let db;
  let server;
  let port;
  let baseUrl;
  let addonToken;
  let sessionCookie;

  before(async () => {
    db = new FullMockPgDatabase();
    const key = crypto.randomBytes(32);
    const cipher = new Cipher(key);
    const fake = new FakeStremio({
      userId: 'test-user-id',
      email: 'tester@example.com',
      password: 'password123',
      authKey: 'auth_key_1234567890',
    }).seed({
      library: [libItem('tt0111161', { name: 'The Shawshank Redemption' })],
      addons: [addon('cinemeta')],
    });

    const stremio = new StremioClient({ fetchImpl: fake.fetch, sleep: async () => {} });
    const settings = await Settings.create({ db, env: { ACCESS: 'open' } });
    const accounts = new AccountsService({
      db,
      cipher,
      stremio,
      sleep: async () => {},
      now: () => Date.now(),
      access: () => settings.access(),
    });

    // Sign in to create initial account
    const { accountId } = await accounts.signIn('tester@example.com', 'password123');
    const account = await db.get('SELECT * FROM accounts WHERE id = $1', [accountId]);
    addonToken = account.addon_token;

    const config = {
      publicUrl: 'https://openprofiles-test.onrender.com',
      trustProxy: true,
      port: 0,
      dataDir: './data',
    };

    const app = createApp({ config, db, accounts, settings });

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('1. GET /health returns 200 { status: "ok" }', async () => {
    const res = await request(baseUrl, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
  });

  it('2. GET /theme.css returns 200 and CSS content-type', async () => {
    const res = await request(baseUrl, 'GET', '/theme.css');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/css'));
  });

  it('3. GET / redirects unauthenticated visitors to /signin', async () => {
    const res = await request(baseUrl, 'GET', '/');
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/signin');
  });

  it('4. POST /signin authenticates and sets session cookie', async () => {
    const form = new URLSearchParams({
      email: 'tester@example.com',
      password: 'password123',
    }).toString();

    const res = await request(baseUrl, 'POST', '/signin', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });

    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/configure');
    assert.ok(res.headers['set-cookie'], 'Set-Cookie header must be present');

    const cookieStr = Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie'].join('; ')
      : res.headers['set-cookie'];

    const match = cookieStr.match(/op_session=([^;]+)/);
    assert.ok(match, 'op_session cookie must be set');
    sessionCookie = `op_session=${match[1]}`;
  });

  it('5. GET /configure with valid session returns 200 HTML page', async () => {
    const res = await request(baseUrl, 'GET', '/configure', {
      headers: { cookie: sessionCookie },
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.text.includes('Original'), 'Web page should display the Original profile');
  });

  it('6. GET /:token/manifest.json serves valid Stremio add-on manifest with CORS', async () => {
    const res = await request(baseUrl, 'GET', `/${addonToken}/manifest.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.json.id, 'community.openprofiles');
    assert.equal(res.json.name, 'OpenProfiles');
    assert.ok(Array.isArray(res.json.catalogs));
    assert.equal(res.json.catalogs[0].type, 'OpenProfiles');
  });

  it('7. GET /:token/catalog/OpenProfiles/openprofiles.json serves profile catalog', async () => {
    const res = await request(baseUrl, 'GET', `/${addonToken}/catalog/OpenProfiles/openprofiles.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.ok(Array.isArray(res.json.metas));
    assert.equal(res.json.metas.length, 1);
    assert.equal(res.json.metas[0].name, 'Original');
  });

  it('8. GET /:token/poster/1.png returns PNG image with CORS', async () => {
    const res = await request(baseUrl, 'GET', `/${addonToken}/poster/1.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.ok(res.headers['content-type'].includes('image/png'));
  });

  it('9. GET /health returns 503 when database is disconnected', async () => {
    db.isHealthy = false;
    const res = await request(baseUrl, 'GET', '/health');
    assert.equal(res.status, 503);
    assert.equal(res.json.status, 'unhealthy');
    db.isHealthy = true;
  });
});

/** Minimal HTTP client for testing */
function request(baseUrl, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      url,
      {
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            // ignore non-json response
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: raw,
            json,
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
