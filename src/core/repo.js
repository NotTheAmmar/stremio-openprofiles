import crypto from 'node:crypto';
import { randomToken } from '../crypto.js';
import { countActive } from './library.js';

export const BACKUP_RETENTION = {
  original: Infinity,
  auto: 14,
  pre_switch: 5,
  pre_restore: 3,
  pre_change: 20,
  manual: 10,
  imported: 20,
};

// Never the passcode hash itself: only whether there is one.
const PROFILE_META = `id, name, avatar_preset, avatar_colour, library_count, addon_count, notif_count,
  snapshot_taken_at, stremio_user_id, created_at, photo_hash, passcode_hash IS NOT NULL AS has_passcode`;
const BACKUP_META = `id, kind, label, library_count, addon_count, notif_count, stremio_user_id, created_at, profile_id, edit_kind, held_profile_id`;
const ACTIVITY_KEEP = 200;

/** Stable fingerprint of a snapshot's content, to tell whether anything changed since a backup. */
export function snapshotHash({ library, addons, notifs }) {
  return crypto.createHash('sha256').update(JSON.stringify([library, addons, notifs ?? null])).digest('hex');
}
/**
 * "Used since @since", for an account row `a`: signed in, seen on the pages, did anything
 * (a switch from Stremio counts), or Stremio asked its add-on for something. One rule for the
 * Server tab's counts and for removing unused accounts.
 */
export const USED_SINCE = `(a.last_login_at > $1
    OR COALESCE(a.last_addon_at, 0) > $1
    OR COALESCE(a.last_seen_at, 0) > $1
    OR EXISTS (SELECT 1 FROM activity WHERE account_id = a.id AND at > $1)
    OR EXISTS (SELECT 1 FROM sessions WHERE account_id = a.id AND last_seen_at > $1))`;
const ADDON_TOUCH_MS = 60 * 60 * 1000;

const ACCOUNT_COLUMNS = `id, stremio_user_id, stremio_email, auth_key_enc, addon_token, active_profile_id,
  addon_installed, enc_version, created_at, last_login_at, created_at AS linked_at`;

/**
 * Encryption bound to one account: every blob's associated data carries the
 * account id, so a blob copied into another account's rows won't decrypt.
 */
export function accountCipher(cipher, accountId) {
  return {
    encryptJson: (value, purpose) => cipher.encryptJson(value, `${purpose}:${accountId}`),
    decryptJson: (blob, purpose) => cipher.decryptJson(blob, `${purpose}:${accountId}`),
  };
}

/**
 * All SQL for one account. Every query is scoped to `accountId`, so nothing
 * here can read or write another account's rows. Blobs are encrypted on the
 * way in; callers decode via guard.js using `this.cipher`.
 */
export class AccountRepo {
  constructor(db, cipher, accountId, now = () => Date.now()) {
    this.db = db;
    this.accountId = accountId;
    this.cipher = accountCipher(cipher, accountId);
    this.now = now;
  }

  async transaction(fn) {
    return await this.db.transaction(async (tx) => {
      const prevDb = this.db;
      this.db = tx;
      try {
        return await fn(this);
      } finally {
        this.db = prevDb;
      }
    });
  }

  encodeSnapshot({ library, addons, notifs }) {
    return {
      library_enc: this.cipher.encryptJson(library, 'library'),
      addons_enc: this.cipher.encryptJson(addons, 'addons'),
      notifs_enc: notifs == null ? null : this.cipher.encryptJson(notifs, 'notifs'),
      library_count: countActive(library),
      addon_count: addons.length,
      notif_count: notifs == null ? null : notifs.length,
    };
  }

  // ── account ──────────────────────────────────────────────────────────────

  async getAccount() {
    return await this.db.get(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`, [this.accountId]) || null;
  }

  async updateAuthKey({ email, authKey }) {
    await this.db.run('UPDATE accounts SET stremio_email = $1, auth_key_enc = $2, last_login_at = $3 WHERE id = $4',
      [email, this.cipher.encryptJson(authKey, 'authkey'), this.now(), this.accountId]);
  }

  async getAuthKey() {
    const row = await this.getAccount();
    return row ? this.cipher.decryptJson(row.auth_key_enc, 'authkey') : null;
  }

  // ── state (lives on the account row) ─────────────────────────────────────

  async getState() {
    return await this.db.get('SELECT active_profile_id, addon_token, addon_installed, notifs_foreign FROM accounts WHERE id = $1',
      [this.accountId]) || null;
  }

  async setActiveProfile(id) {
    await this.db.run('UPDATE accounts SET active_profile_id = $1 WHERE id = $2', [id, this.accountId]);
  }

  async setAddonToken(token) {
    await this.db.run('UPDATE accounts SET addon_token = $1 WHERE id = $2', [token, this.accountId]);
  }

  /** Whether Stremio's notifications belong to some other profile than the active one. */
  async setNotifsForeign(foreign) {
    await this.db.run('UPDATE accounts SET notifs_foreign = $1 WHERE id = $2', [foreign ? 1 : 0, this.accountId]);
  }

  async setAddonInstalled(installed) {
    await this.db.run('UPDATE accounts SET addon_installed = $1 WHERE id = $2', [installed ? 1 : 0, this.accountId]);
  }

  // ── profiles ─────────────────────────────────────────────────────────────

  async listProfiles() {
    return await this.db.all(`SELECT ${PROFILE_META} FROM profiles
      WHERE account_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`, [this.accountId]);
  }

  async getProfile(id) {
    return await this.db.get(`SELECT ${PROFILE_META} FROM profiles
      WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [id, this.accountId]) || null;
  }

  /** Includes the encrypted blobs. */
  async getProfileRow(id) {
    return await this.db.get('SELECT * FROM profiles WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL',
      [id, this.accountId]) || null;
  }

  async insertProfile({ name, avatarPreset, avatarColour, stremioUserId, snapshot }) {
    const enc = this.encodeSnapshot(snapshot);
    const now = this.now();
    const row = await this.db.get(`INSERT INTO profiles
      (account_id, name, avatar_preset, avatar_colour, library_enc, addons_enc, notifs_enc, library_count, addon_count,
       notif_count, snapshot_taken_at, stremio_user_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11)
      RETURNING id`,
      [this.accountId, name, avatarPreset, avatarColour, enc.library_enc, enc.addons_enc, enc.notifs_enc,
       enc.library_count, enc.addon_count, enc.notif_count, now, stremioUserId]);
    return Number(row.id);
  }

  /** `snapshot.notifs === null` keeps the previously saved notifications. */
  async saveProfileSnapshot(id, snapshot) {
    const enc = this.encodeSnapshot(snapshot);
    const keepNotifs = snapshot.notifs == null;
    if (keepNotifs) {
      await this.db.run(`UPDATE profiles SET library_enc = $1, addons_enc = $2,
          library_count = $3, addon_count = $4, snapshot_taken_at = $5
        WHERE id = $6 AND account_id = $7`,
        [enc.library_enc, enc.addons_enc, enc.library_count, enc.addon_count, this.now(), id, this.accountId]);
    } else {
      await this.db.run(`UPDATE profiles SET library_enc = $1, addons_enc = $2,
          library_count = $3, addon_count = $4, snapshot_taken_at = $5,
          notifs_enc = $6, notif_count = $7
        WHERE id = $8 AND account_id = $9`,
        [enc.library_enc, enc.addons_enc, enc.library_count, enc.addon_count, this.now(),
         enc.notifs_enc, enc.notif_count, id, this.accountId]);
    }
  }

  /** Replace only the saved library; the add-ons, notifications and "saved at" time stay. */
  async saveProfileLibrary(id, library) {
    await this.db.run('UPDATE profiles SET library_enc = $1, library_count = $2 WHERE id = $3 AND account_id = $4',
      [this.cipher.encryptJson(library, 'library'), countActive(library), id, this.accountId]);
  }

  /** Replace only the saved add-on list; the library, notifications and "saved at" time stay. */
  async saveProfileAddons(id, addons) {
    await this.db.run('UPDATE profiles SET addons_enc = $1, addon_count = $2 WHERE id = $3 AND account_id = $4',
      [this.cipher.encryptJson(addons, 'addons'), addons.length, id, this.accountId]);
  }

  async renameProfile(id, name) {
    await this.db.run('UPDATE profiles SET name = $1 WHERE id = $2 AND account_id = $3', [name, id, this.accountId]);
  }

  async setProfileAvatar(id, preset, colour) {
    await this.db.run('UPDATE profiles SET avatar_preset = $1, avatar_colour = $2 WHERE id = $3 AND account_id = $4',
      [preset, colour, id, this.accountId]);
  }

  /** The profile's uploaded photo (JPEG bytes), or null. Works for profiles in the bin too. */
  async getProfilePhoto(id) {
    const row = await this.db.get('SELECT photo_enc FROM profiles WHERE id = $1 AND account_id = $2', [id, this.accountId]);
    return row?.photo_enc ? Buffer.from(this.cipher.decryptJson(row.photo_enc, 'photo'), 'base64') : null;
  }

  /** `jpeg` null removes the photo. The hash is what avatar_preset 'photo:<hash>' points at. */
  async setProfilePhoto(id, jpeg, hash) {
    await this.db.run('UPDATE profiles SET photo_enc = $1, photo_hash = $2 WHERE id = $3 AND account_id = $4',
      [jpeg ? this.cipher.encryptJson(jpeg.toString('base64'), 'photo') : null, jpeg ? hash : null, id, this.accountId]);
  }

  /** The profile's passcode hash (core/passcode.js), or null when it isn't locked. */
  async getPasscodeHash(id) {
    const row = await this.db.get('SELECT passcode_hash FROM profiles WHERE id = $1 AND account_id = $2', [id, this.accountId]);
    return row?.passcode_hash ?? null;
  }

  /** `hash` null removes the lock. */
  async setPasscodeHash(id, hash) {
    await this.db.run('UPDATE profiles SET passcode_hash = $1 WHERE id = $2 AND account_id = $3', [hash, id, this.accountId]);
  }

  async countProfiles() {
    const row = await this.db.get('SELECT COUNT(*) AS n FROM profiles WHERE account_id = $1 AND deleted_at IS NULL', [this.accountId]);
    return Number(row?.n || 0);
  }

  // ── the bin (deleted profiles, kept BIN_DAYS) ────────────────────────────

  async moveProfileToBin(id) {
    await this.db.run('UPDATE profiles SET deleted_at = $1 WHERE id = $2 AND account_id = $3 AND deleted_at IS NULL',
      [this.now(), id, this.accountId]);
  }

  async listBin() {
    return await this.db.all(`SELECT ${PROFILE_META}, deleted_at FROM profiles
      WHERE account_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`, [this.accountId]);
  }

  async getBinProfile(id) {
    return await this.db.get(`SELECT ${PROFILE_META}, deleted_at FROM profiles
      WHERE id = $1 AND account_id = $2 AND deleted_at IS NOT NULL`, [id, this.accountId]) || null;
  }

  /** Includes the encrypted blobs. */
  async getBinProfileRow(id) {
    return await this.db.get('SELECT * FROM profiles WHERE id = $1 AND account_id = $2 AND deleted_at IS NOT NULL',
      [id, this.accountId]) || null;
  }

  async restoreProfileFromBin(id, name) {
    await this.db.run('UPDATE profiles SET deleted_at = NULL, name = $1 WHERE id = $2 AND account_id = $3', [name, id, this.accountId]);
  }

  /** Keep at most `max` profiles in the bin, removing the longest-deleted first. */
  async trimBin(max) {
    const result = await this.db.run(`DELETE FROM profiles WHERE account_id = $1 AND deleted_at IS NOT NULL AND id NOT IN
      (SELECT id FROM profiles WHERE account_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC LIMIT $2)`,
      [this.accountId, max]);
    return result.changes;
  }

  /** Permanently remove bin entries deleted before `before` (ms). Returns how many. */
  async purgeBin(before) {
    const result = await this.db.run('DELETE FROM profiles WHERE account_id = $1 AND deleted_at IS NOT NULL AND deleted_at < $2',
      [this.accountId, before]);
    return result.changes;
  }

  // ── activity log ─────────────────────────────────────────────────────────

  async logActivity(kind, detail) {
    await this.db.run('INSERT INTO activity (account_id, at, kind, detail) VALUES ($1, $2, $3, $4)',
      [this.accountId, this.now(), kind, String(detail).slice(0, 300)]);
    await this.db.run(`DELETE FROM activity WHERE account_id = $1 AND id NOT IN
      (SELECT id FROM activity WHERE account_id = $1 ORDER BY id DESC LIMIT ${ACTIVITY_KEEP})`,
      [this.accountId]);
  }

  async listActivity(limit = 30) {
    return await this.db.all('SELECT at, kind, detail FROM activity WHERE account_id = $1 ORDER BY id DESC LIMIT $2',
      [this.accountId, limit]);
  }

  // ── backups ──────────────────────────────────────────────────────────────

  /**
   * `profileId`: for pre_change backups, the profile whose saved state this is (undo puts it back there).
   * `editKind`: for pre_change backups, what the edit was ('addons' | 'cinemeta' | 'undo').
   */
  async insertBackup({ kind, label, stremioUserId, snapshot, profileId = null, editKind = null, createdAt = null }) {
    const enc = this.encodeSnapshot(snapshot);
    const now = this.now();
    const at = Number.isFinite(createdAt) && createdAt > 0 ? Math.min(createdAt, now) : now;
    // Whose state it is: the edited profile for an edit, else the one in use now; an import's is unknown.
    const held = kind === 'imported' ? null : profileId ?? (await this.getState())?.active_profile_id ?? null;
    const row = await this.db.get(`INSERT INTO backups
      (account_id, kind, label, library_enc, addons_enc, notifs_enc, library_count, addon_count, notif_count,
       stremio_user_id, created_at, content_hash, profile_id, edit_kind, held_profile_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id`,
      [this.accountId, kind, label, enc.library_enc, enc.addons_enc, enc.notifs_enc, enc.library_count,
       enc.addon_count, enc.notif_count, stremioUserId, at, snapshotHash(snapshot), profileId, editKind, held]);
    return Number(row.id);
  }

  /** The newest add-on or Cinemeta edit since `since` that hasn't been undone, if its profile still exists. */
  async latestUndoableEdit(since) {
    return await this.db.get(`SELECT b.id, b.label, b.created_at, b.edit_kind, b.profile_id, p.name AS profile_name
      FROM backups b JOIN profiles p ON p.id = b.profile_id AND p.deleted_at IS NULL
      WHERE b.account_id = $1 AND b.kind = 'pre_change' AND b.edit_kind IN ('addons', 'cinemeta')
        AND b.undone_at IS NULL AND b.created_at >= $2
      ORDER BY b.created_at DESC, b.id DESC LIMIT 1`, [this.accountId, since]) || null;
  }

  /** For an edit's backup: the add-on list the edit wrote. */
  async setAfterHash(id, hash) {
    await this.db.run('UPDATE backups SET after_hash = $1 WHERE id = $2 AND account_id = $3', [hash, id, this.accountId]);
  }

  async markUndone(id) {
    await this.db.run('UPDATE backups SET undone_at = $1 WHERE id = $2 AND account_id = $3', [this.now(), id, this.accountId]);
  }

  /** Newest backup of a kind (metadata and hash only), or null. */
  async latestBackup(kind) {
    return await this.db.get(`SELECT ${BACKUP_META}, content_hash FROM backups WHERE account_id = $1 AND kind = $2
      ORDER BY created_at DESC, id DESC LIMIT 1`, [this.accountId, kind]) || null;
  }

  async listBackups() {
    return await this.db.all(`SELECT ${BACKUP_META} FROM backups WHERE account_id = $1
      ORDER BY created_at DESC, id DESC`, [this.accountId]);
  }

  async getBackup(id) {
    return await this.db.get(`SELECT ${BACKUP_META} FROM backups WHERE id = $1 AND account_id = $2`,
      [id, this.accountId]) || null;
  }

  async getBackupRow(id) {
    return await this.db.get('SELECT * FROM backups WHERE id = $1 AND account_id = $2', [id, this.accountId]) || null;
  }

  async deleteBackup(id) {
    await this.db.run('DELETE FROM backups WHERE id = $1 AND account_id = $2', [id, this.accountId]);
  }

  /** Backups an open journal row may still need for recovery. */
  async pinnedBackupIds() {
    const rows = await this.db.all(`SELECT target_backup_id, rollback_backup_id FROM switch_journal
      WHERE account_id = $1 AND status = 'open'`, [this.accountId]);
    return new Set(rows.flatMap((r) => [r.target_backup_id, r.rollback_backup_id]).filter((id) => id != null));
  }

  /** Apply BACKUP_RETENTION, newest kept. Returns how many were deleted. */
  async pruneBackups() {
    const pinned = await this.pinnedBackupIds();
    let deleted = 0;
    for (const [kind, keep] of Object.entries(BACKUP_RETENTION)) {
      if (keep === Infinity) continue;
      const rows = await this.db.all(`SELECT id FROM backups WHERE account_id = $1 AND kind = $2
        ORDER BY created_at DESC, id DESC`, [this.accountId, kind]);
      for (const { id } of rows.slice(keep)) {
        if (pinned.has(id)) continue;
        await this.deleteBackup(id);
        deleted++;
      }
    }
    return deleted;
  }

  // ── journal ──────────────────────────────────────────────────────────────

  async startJournal({ kind, fromProfileId, toProfileId, targetBackupId = null, rollbackBackupId }) {
    const row = await this.db.get(`INSERT INTO switch_journal
      (account_id, kind, from_profile_id, to_profile_id, target_backup_id, rollback_backup_id, phase, status, started_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'saved', 'open', $7)
      RETURNING id`,
      [this.accountId, kind, fromProfileId, toProfileId, targetBackupId, rollbackBackupId, this.now()]);
    return Number(row.id);
  }

  async setJournalPhase(id, phase) {
    await this.db.run('UPDATE switch_journal SET phase = $1 WHERE id = $2 AND account_id = $3', [phase, id, this.accountId]);
  }

  async failJournal(id, error) {
    await this.db.run('UPDATE switch_journal SET error = $1 WHERE id = $2 AND account_id = $3',
      [String(error).slice(0, 500), id, this.accountId]);
  }

  async closeJournal(id, status, warnings = []) {
    await this.db.run(`UPDATE switch_journal SET status = $1, phase = 'done', finished_at = $2, error = NULL, warnings = $3
      WHERE id = $4 AND account_id = $5`, [status, this.now(), JSON.stringify(warnings), id, this.accountId]);
  }

  // ── titles followed after a switch (core/carryover.js) ──────────────────

  async listCarryovers() {
    const rows = await this.db.all('SELECT * FROM carryovers WHERE account_id = $1 ORDER BY id', [this.accountId]);
    return rows.map((row) => ({
      ownerProfileId: row.owner_profile_id,
      createdAt: row.created_at,
      changedAt: row.changed_at,
      expiresAt: row.expires_at,
      ...this.cipher.decryptJson(row.item_enc, 'carryover'),
    }));
  }

  /** The account's whole list, replaced. Titles are viewing history, so they're encrypted. */
  async replaceCarryovers(records) {
    await this.db.run('DELETE FROM carryovers WHERE account_id = $1', [this.accountId]);
    for (const r of records) {
      const enc = this.cipher.encryptJson({
        base: r.base, written: r.written, seenMtime: r.seenMtime ?? null, putMtime: r.putMtime ?? null,
      }, 'carryover');
      await this.db.run(`INSERT INTO carryovers
        (account_id, owner_profile_id, item_enc, created_at, changed_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.accountId, r.ownerProfileId, enc, r.createdAt, r.changedAt ?? null, r.expiresAt]);
    }
  }

  /**
   * The last switch, for the one look at the whole library a few minutes after
   * it (service.js strayRecords): `{ switchAt, fromProfileId, toProfileId }`,
   * or null. Kept in meta so a restart doesn't lose it.
   */
  async getSweep() {
    const row = await this.db.get('SELECT value FROM meta WHERE key = $1', [`sweep:${this.accountId}`]);
    try {
      return row ? JSON.parse(row.value) : null;
    } catch {
      return null;
    }
  }

  async setSweep(sweep) {
    const key = `sweep:${this.accountId}`;
    if (!sweep) await this.db.run('DELETE FROM meta WHERE key = $1', [key]);
    else await this.db.run('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(sweep)]);
  }

  async getOpenJournal() {
    const row = await this.db.get(`SELECT * FROM switch_journal WHERE account_id = $1 AND status = 'open'
      ORDER BY id DESC LIMIT 1`, [this.accountId]);
    return row ? { ...row, warnings: JSON.parse(row.warnings) } : null;
  }

  async recentJournal(limit = 10) {
    const rows = await this.db.all('SELECT * FROM switch_journal WHERE account_id = $1 ORDER BY id DESC LIMIT $2',
      [this.accountId, limit]);
    return rows.map((row) => ({ ...row, warnings: JSON.parse(row.warnings) }));
  }
}

/** Server-wide account rows: sign-in lookup, add-on token lookup, creation and deletion. */
export class Accounts {
  constructor(db, cipher, now = () => Date.now()) {
    this.db = db;
    this.cipher = cipher;
    this.now = now;
  }

  async count() {
    const row = await this.db.get('SELECT COUNT(*) AS n FROM accounts');
    return Number(row?.n || 0);
  }

  async byStremioUserId(stremioUserId) {
    return await this.db.get(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE stremio_user_id = $1`, [stremioUserId]) || null;
  }

  async byId(id) {
    return await this.db.get(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`, [id]) || null;
  }

  async byAddonToken(token) {
    if (typeof token !== 'string' || token.length < 16) return null;
    return await this.db.get(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE addon_token = $1`, [token]) || null;
  }

  /** Inserts the row only; call inside the transaction that also creates the first profile. */
  async insert({ stremioUserId, email, authKey }) {
    const now = this.now();
    const row = await this.db.get(`INSERT INTO accounts
      (stremio_user_id, stremio_email, auth_key_enc, addon_token, enc_version, created_at, last_login_at)
      VALUES ($1, $2, '\\x00', $3, 2, $4, $5)
      RETURNING id`, [stremioUserId, email, randomToken(), now, now]);
    const id = Number(row.id);
    // The auth key is bound to the new id, so it can only be encrypted once the id exists.
    await this.db.run('UPDATE accounts SET auth_key_enc = $1 WHERE id = $2',
      [accountCipher(this.cipher, id).encryptJson(authKey, 'authkey'), id]);
    return id;
  }

  /** Stremio used this account's add-on. Writes at most once an hour. */
  async touchAddon(id) {
    const now = this.now();
    await this.db.run('UPDATE accounts SET last_addon_at = $1 WHERE id = $2 AND (last_addon_at IS NULL OR last_addon_at < $3)',
      [now, id, now - ADDON_TOUCH_MS]);
  }

  /** Accounts following titles that kept playing after a switch, or with a switch still to look over. */
  async withCarryovers() {
    const rows = await this.db.all(`SELECT account_id FROM carryovers
      UNION SELECT CAST(substr(key, 7) AS INTEGER) FROM meta WHERE key LIKE 'sweep:%'
      ORDER BY 1`);
    return rows.map((r) => r.account_id);
  }

  /**
   * Accounts set up before `since` and not used since (see USED_SINCE). Not one
   * with a switch that never finished: its Stremio may be half-switched, and the
   * profiles to put it right are only here.
   */
  async unusedSince(since) {
    const rows = await this.db.all(`SELECT a.id FROM accounts a WHERE a.created_at <= $1 AND NOT ${USED_SINCE}
      AND NOT EXISTS (SELECT 1 FROM switch_journal WHERE account_id = a.id AND status = 'open') ORDER BY a.id`,
      [since]);
    return rows.map((r) => r.id);
  }

  /** Everything for the account goes with it (foreign keys cascade; its meta row by hand). */
  async delete(id) {
    await this.db.run('DELETE FROM accounts WHERE id = $1', [id]);
    await this.db.run('DELETE FROM meta WHERE key = $1', [`sweep:${id}`]);
  }
}
