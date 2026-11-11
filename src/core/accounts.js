import { silentLogger } from '../log.js';
import { AccountRepo, Accounts } from './repo.js';
import { Mutex } from './lock.js';
import {
  DEFAULT_COLOUR, NATIVE_PROFILES_WARNING, ProfilesService, UserError, checkLiveSize, readLiveState,
} from './service.js';

/**
 * Who may sign in:
 *   owner  the first account to sign in owns the server; nobody else can join (self-hosting default)
 *   list   only `allowed` (Stremio emails or user ids)
 *   open   anyone, up to `maxAccounts` (a hosted instance)
 * Accounts that already exist can always sign back in, except under `list`
 * when they have been taken off the list. Whoever runs the server (`admin`)
 * always gets in, so no rule saved on the Server tab can lock them out.
 */
export function accessDecision({ mode, allowed = [], maxAccounts = Infinity }, { user, existing, accountCount, admin = false }) {
  if (admin) return null;
  const listed = allowed.some((entry) => entry.toLowerCase() === user.email.toLowerCase() || entry === user.id);
  if (mode === 'list') {
    return listed ? null : "Your Stremio account isn't on this server's list. Ask whoever runs it to add you.";
  }
  if (existing) return null;
  if (mode === 'open') {
    return accountCount < maxAccounts ? null : 'This server is full. Try again later or run your own (it is free and open source).';
  }
  // owner
  return accountCount === 0 ? null : 'This OpenProfiles server already belongs to someone. You can run your own; it is free and open source.';
}

/**
 * The server's accounts. Signing in with Stremio creates the account the first
 * time (its current state becomes the "Original" profile, plus a permanent
 * backup) and renews the stored Stremio key after that. Each account gets its
 * own ProfilesService, so each has its own lock and only sees its own rows.
 */
export class AccountsService {
  /**
   * `access` is the sign-in rule, or a function returning it (the Server tab
   * can change it while running). `admins`: Stremio emails or user ids that run
   * the server besides its owner (the first account), from ADMINS.
   */
  constructor({ db, cipher, stremio, log = silentLogger, sleep, now = () => Date.now(), selfAddon = null, access = { mode: 'owner' }, admins = [], fetchManifest = null }) {
    this.db = db;
    this.cipher = cipher;
    this.stremio = stremio;
    this.log = log;
    this.sleep = sleep;
    this.now = now;
    this.selfAddon = selfAddon;
    this.access = typeof access === 'function' ? access : () => access;
    this.admins = admins;
    this.fetchManifest = fetchManifest;
    this.accounts = new Accounts(db, cipher, now);
    this.services = new Map();
    // Serialises account creation, so two first sign-ins can't both claim an `owner` server.
    this.signInLock = new Mutex();
  }

  forAccount(accountId) {
    let service = this.services.get(accountId);
    if (!service) {
      const repo = new AccountRepo(this.db, this.cipher, accountId, this.now);
      service = new ProfilesService({ repo, stremio: this.stremio, log: this.log, sleep: this.sleep, now: this.now, selfAddon: this.selfAddon, fetchManifest: this.fetchManifest });
      this.services.set(accountId, service);
    }
    return service;
  }

  /** The account an add-on URL token belongs to, or null. */
  async byAddonToken(token) {
    const account = await this.accounts.byAddonToken(token);
    return account ? { account, service: this.forAccount(account.id) } : null;
  }

  async getAccount(accountId) {
    return await this.accounts.byId(accountId);
  }

  /**
   * The account that runs the server: the Stremio account that set up the first
   * account ever. It's kept by Stremio user id, because account ids can be used
   * again: if the owner deletes their account, nobody signing up after inherits
   * the server, and the owner signing in again owns it again. Null meanwhile.
   */
  async ownerId() {
    const row = await this.db.get(`SELECT a.id FROM meta m JOIN accounts a ON a.stremio_user_id = m.value
      WHERE m.key = 'owner_stremio_user_id'`);
    return row ? row.id : null;
  }

  async isOwner(user) {
    const row = await this.db.get("SELECT value FROM meta WHERE key = 'owner_stremio_user_id'");
    return Boolean(row?.value) && row.value === user.id;
  }

  /** Whether this account runs the server (and sees the Server tab). */
  async isAdmin(accountId) {
    if (accountId == null) return false;
    if (accountId === await this.ownerId()) return true;
    const account = await this.accounts.byId(accountId);
    return Boolean(account && this.listedAdmin({ email: account.stremio_email, id: account.stremio_user_id }));
  }

  listedAdmin(user) {
    return this.admins.some((entry) => entry.toLowerCase() === String(user.email).toLowerCase() || entry === user.id);
  }

  async signIn(email, password) {
    return this.signInLock.run(async () => {
      const authKey = await this.stremio.login(email, password);
      const user = await this.stremio.getUser(authKey);
      if (user.parentId) {
        throw new UserError('CHILD_PROFILE', 'That sign-in belongs to a profile inside another Stremio account. Sign in with the main account.');
      }
      const existing = await this.accounts.byStremioUserId(user.id);
      const access = this.access();
      const admin = (await this.isOwner(user)) || this.listedAdmin(user);
      const accountCount = await this.accounts.count();
      const refusal = accessDecision(access, { user, existing, accountCount, admin });
      if (refusal) {
        this.log.warn('Sign-in refused by the access rule', { mode: access.mode });
        throw new UserError('NOT_ALLOWED', refusal);
      }
      const warnings = [];
      if (user.userProfiles && Object.keys(user.userProfiles).length > 1) warnings.push(NATIVE_PROFILES_WARNING);

      if (existing) {
        await this.forAccount(existing.id).repo.updateAuthKey({ email: user.email, authKey });
        await this.forAccount(existing.id).repo.logActivity('signin', 'Signed in');
        this.log.info('Signed in', { accountId: existing.id });
        return { accountId: existing.id, created: false, warnings };
      }

      const live = await readLiveState(this.stremio, authKey, this.log);
      checkLiveSize(live);
      if (live.addons.length === 0) {
        throw new UserError('NO_ADDONS', 'This Stremio account has no add-ons installed. Install Cinemeta in Stremio, then sign in again.');
      }
      const snapshot = { library: live.library, addons: live.addons, notifs: live.notifs };
      const accountId = await this.db.transaction(async (tx) => {
        const now = this.now();
        const row = await tx.get(
          `INSERT INTO accounts (stremio_user_id, stremio_email, auth_key_enc, addon_token, enc_version, created_at, last_login_at)
           VALUES ($1, $2, '\\x00', $3, 2, $4, $5) RETURNING id`,
          [user.id, user.email, (await import('../crypto.js')).randomToken(), now, now]
        );
        const id = Number(row.id);
        const repo = new AccountRepo(tx, this.cipher, id, this.now);
        await tx.run('UPDATE accounts SET auth_key_enc = $1 WHERE id = $2',
          [repo.cipher.encryptJson(authKey, 'authkey'), id]);
        const profileId = await repo.insertProfile({ name: 'Original', avatarPreset: 'initial', avatarColour: DEFAULT_COLOUR, stremioUserId: user.id, snapshot });
        await repo.setActiveProfile(profileId);
        await repo.insertBackup({ kind: 'original', label: 'Account as it was at setup', stremioUserId: user.id, snapshot });
        // The first account ever set up runs the server.
        await tx.run("INSERT INTO meta (key, value) VALUES ('owner_stremio_user_id', $1) ON CONFLICT (key) DO NOTHING", [user.id]);
        return id;
      });
      await this.replaceStaleAddon(accountId, authKey, live.addons);
      await this.forAccount(accountId).repo.logActivity('signin', 'Account set up: your Stremio account was saved as "Original"');
      this.log.info('Account created', { accountId, libraryItems: snapshot.library.length, addons: snapshot.addons.length });
      return { accountId, created: true, warnings };
    });
  }

  /**
   * A new account whose Stremio still has this server's add-on from an account
   * removed earlier: that link is dead now, so the add-on is pointed at the new
   * account's. If Stremio refuses the write, the sign-in still goes ahead and
   * the page offers to install the add-on.
   */
  async replaceStaleAddon(accountId, authKey, addons) {
    const service = this.forAccount(accountId);
    const state = await service.repo.getState();
    const token = state?.addon_token;
    const profileId = state?.active_profile_id;
    let list = addons;
    if (this.selfAddon && addons.some((a) => this.selfAddon.isStale(a, token))) {
      try {
        const next = service.prepareAddons(addons, profileId, token);
        await this.stremio.setAddons(authKey, next);
        list = next;
        this.log.info("Pointed an old copy of the add-on at the new account's link", { accountId });
      } catch (err) {
        this.log.warn("Couldn't point an old copy of the add-on at the new account's link", { accountId, error: err.message });
      }
    }
    await service.noteAddons(list);
  }

  /**
   * Remove an account and everything stored for it. Waits for its running
   * operation to finish first. The Stremio account itself is left as it is.
   */
  async deleteAccount(accountId, { reason = null } = {}) {
    const service = this.forAccount(accountId);
    await service.lock.run(async () => {
      await this.accounts.delete(accountId);
    });
    this.services.delete(accountId);
    this.log.info('Account deleted', { accountId, ...(reason ? { reason } : {}) });
  }

  /** Stremio asked this account's add-on for something: it counts as used. */
  noteAddonUse(accountId) {
    this.accounts.touchAddon(accountId).catch(() => {});
  }

  /**
   * Remove the accounts nobody has used since `since` (see USED_SINCE in repo.js),
   * never the owner or ADMINS, and at most `limit` of them. Each is checked again
   * right before it goes, in case it was used meanwhile. Returns how many were
   * removed, and how many more are due (left for the next run by the limit).
   */
  async removeUnused(since, { limit = Infinity } = {}) {
    const allUnused = await this.accounts.unusedSince(since);
    const due = [];
    for (const id of allUnused) {
      if (!(await this.isAdmin(id))) due.push(id);
    }
    let removed = 0;
    for (const id of due.slice(0, limit)) {
      const stillUnused = await this.accounts.unusedSince(since);
      if (!stillUnused.includes(id)) continue;
      await this.deleteAccount(id, { reason: 'unused' });
      removed++;
    }
    return { removed, left: Math.max(0, due.length - limit) };
  }
}
