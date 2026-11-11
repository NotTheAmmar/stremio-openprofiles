import { createSelfAddon } from './addon/manifest.js';
import { ConfigError, loadConfig } from './config.js';
import { Cipher, loadOrCreateKey } from './crypto.js';
import { openDatabase } from './db.js';
import { AccountsService } from './core/accounts.js';
import { fetchManifest } from './core/fetchGuard.js';
import { WrongKeyError, checkSecretKey } from './core/keycheck.js';
import { upgradeLegacyEncryption } from './core/rekey.js';
import { startScheduler } from './core/scheduler.js';
import { Settings } from './core/settings.js';
import { createLogger } from './log.js';
import { StremioClient } from './stremio/client.js';
import { createApp } from './web/app.js';

const SHUTDOWN_GRACE_MS = 25_000;

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const log = createLogger(config.logLevel);
  if (config.legacyAdminPassword) {
    log.warn('ADMIN_PASSWORD is no longer used: people sign in with their Stremio account. Remove it from your settings.');
  }

  // Load or generate the encryption key.
  const key = loadOrCreateKey(config);
  const cipher = new Cipher(key);

  // Connect to PostgreSQL (Supabase).
  let db;
  try {
    db = await openDatabase(config.databaseUrl);
    log.info('Connected to PostgreSQL');
  } catch (err) {
    log.error(`Database connection failed: ${err.message}`);
    process.exit(1);
  }

  try {
    await checkSecretKey(db, key, cipher);
  } catch (err) {
    if (err instanceof WrongKeyError) {
      log.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  await upgradeLegacyEncryption(db, cipher, log);

  // Server tab values override the environment's from here on.
  const settings = await Settings.create({ db, env: process.env });
  log.setLevel(settings.get('logLevel'));
  settings.onChange((keys) => {
    if (keys.includes('logLevel')) log.setLevel(settings.get('logLevel'));
    log.info('Server settings changed', { settings: keys });
  });
  const stremio = new StremioClient({ baseUrl: config.stremioApiUrl, log });
  const accounts = new AccountsService({
    db, cipher, stremio, log,
    selfAddon: createSelfAddon(config, () => settings.addon()),
    access: () => settings.access(),
    admins: config.admins,
    fetchManifest: (url) => fetchManifest(url, { allowPrivate: config.allowPrivateAddons }),
  });

  const openCount = await db.get("SELECT COUNT(*) AS n FROM switch_journal WHERE status = 'open'");
  if (openCount?.n) log.warn('Some earlier switches did not finish; each account sees a recovery prompt on its page', { open: openCount.n });
  const accountCount = await accounts.accounts.count();
  log.info('Access rule', { mode: settings.access().mode, accounts: accountCount });

  const scheduler = startScheduler({ db, accounts, settings, log });

  const app = createApp({ config, db, accounts, log, settings });
  const server = app.listen(config.port, '0.0.0.0', () => {
    log.info(`OpenProfiles listening on port ${config.port}`, { publicUrl: config.publicUrl });
  });

  // Let running switches finish before exiting; if one can't in time, its
  // journal records it and the web page offers recovery on next boot.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    scheduler.stop();
    server.close();
    const timeout = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    const idle = Promise.all([...accounts.services.values()].map((s) => s.lock.idle()));
    await Promise.race([idle, timeout]);
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
