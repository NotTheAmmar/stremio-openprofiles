import { silentLogger } from '../log.js';
import { BIN_DAYS } from './service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SNAPSHOT_RE = /^openprofiles-(\d{4}-\d{2}-\d{2})\.db$/;
// Unused accounts: a longer pause between daily runs means the server was down (see runDaily),
// and one run removes at most this many, so a mistake can't empty a server in one night.
const CLOCK_GAP_MS = 2 * DAY_MS;
const MAX_REMOVALS = 5;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The once-a-day jobs: removing accounts nobody has used
 * for removeUnusedDays of the server running (shared servers with ACCESS=open only), each account's
 * automatic backup (skipped when nothing changed) and emptying bins of
 * profiles deleted more than BIN_DAYS ago. One account's failure doesn't stop
 * the others.
 */
export async function runDaily({ db, accounts, settings = null, log = silentLogger, now = () => Date.now(), pause = () => new Promise((r) => setTimeout(r, 2000)) }) {
  const summary = { removed: 0, backedUp: 0, skipped: 0, failed: 0, purged: 0 };
  const meta = async (key) => (await db.get('SELECT value FROM meta WHERE key = $1', [key]))?.value ?? null;
  const setMeta = async (key, value) => await db.run('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, value]);
  // "Unused" only counts time the server was up: nobody could use it while it was down. After a
  // gap (no run for over CLOCK_GAP_MS, or never) the count starts again from now.
  let previous = null;
  try {
    previous = JSON.parse(await meta('last_daily_summary'))?.at ?? null;
  } catch {
    // never ran, or written by an older version
  }
  if (previous == null || now() - previous > CLOCK_GAP_MS || (await meta('unused_clock_since')) == null) {
    await setMeta('unused_clock_since', String(now()));
  }
  const days = settings && settings.get('access') === 'open' ? settings.get('removeUnusedDays') : 0;
  const since = now() - days * DAY_MS;
  if (days > 0 && since >= Number(await meta('unused_clock_since'))) {
    try {
      const { removed, left } = await accounts.removeUnused(since, { limit: MAX_REMOVALS });
      summary.removed = removed;
      if (left) log.info('More unused accounts are due; they go in the next daily runs', { removed, left });
    } catch (err) {
      log.error('Removing unused accounts failed', { error: err.message });
    }
  }
  const ids = (await db.all('SELECT id FROM accounts ORDER BY id')).map((r) => r.id);
  for (const [i, id] of ids.entries()) {
    const service = accounts.forAccount(id);
    try {
      const result = await service.autoBackup();
      if (result.done) summary.backedUp++;
      else summary.skipped++;
    } catch (err) {
      summary.failed++;
      log.warn('Daily backup failed for an account', { accountId: id, error: err.userMessage || err.message });
    }
    try {
      summary.purged += await service.repo.purgeBin(now() - BIN_DAYS * DAY_MS);
    } catch (err) {
      log.warn('Emptying the bin failed for an account', { accountId: id, error: err.message });
    }
    if (i < ids.length - 1) await pause();
  }
  await setMeta('last_daily', dayOf(now()));
  // Counts only, for the Server tab.
  await setMeta('last_daily_summary', JSON.stringify({ at: now(), ...summary }));
  log.info('Daily jobs done', summary);
  return summary;
}

/** How often titles still playing elsewhere after a switch are checked (core/carryover.js). */
export const CARRYOVER_CHECK_MS = 3 * 60 * 1000;

/** One round of the check, for every account following such titles. Returns how many were put back. */
export async function checkCarryovers({ accounts, log = silentLogger }) {
  let settled = 0;
  for (const id of await accounts.accounts.withCarryovers()) {
    try {
      settled += (await accounts.forAccount(id).checkCarryovers()).settled;
    } catch (err) {
      log.warn('Checking titles played elsewhere failed for an account', { accountId: id, error: err.userMessage || err.message });
    }
  }
  return settled;
}

/**
 * Runs the daily jobs once per UTC day (shortly after boot if due, then
 * checks hourly), and the carry-over check every CARRYOVER_CHECK_MS.
 */
export function startScheduler({ db, accounts, settings = null, log = silentLogger }) {
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      await checkCarryovers({ accounts, log });
    } catch (err) {
      log.error('Carryover check failed', { error: err.message });
    } finally {
      checking = false;
    }
  };
  const carry = setInterval(check, CARRYOVER_CHECK_MS);
  carry.unref();

  let running = false;
  const tick = async () => {
    if (running) return;
    try {
      const row = await db.get("SELECT value FROM meta WHERE key = 'last_daily'");
      const last = row?.value;
      if (last === dayOf(Date.now())) return;
      running = true;
      try {
        await runDaily({ db, accounts, settings, log });
      } catch (err) {
        log.error('Daily jobs failed', { error: err.message });
      } finally {
        running = false;
      }
    } catch (err) {
      log.error('Daily tick failed', { error: err.message });
    }
  };
  const first = setTimeout(tick, 2 * 60 * 1000);
  const every = setInterval(tick, 60 * 60 * 1000);
  first.unref();
  every.unref();
  return { stop: () => { clearTimeout(first); clearInterval(every); clearInterval(carry); }, tick, check };
}
