import { createRequire } from 'node:module';
import { USED_SINCE } from './repo.js';

const { version } = createRequire(import.meta.url)('../../package.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const UNUSED_DAYS = 60;
const LATE_MS = 26 * 60 * 60 * 1000;

/**
 * What the Server tab shows: counts and server facts only. Nothing here may
 * name, or let anyone pick out, an account: no emails, ids, profile names or
 * per-account rows, and errors are grouped by their fixed log message.
 */
export async function serverStats({ db, settings, log, startedAt, now = Date.now() }) {
  const one = async (sql, ...args) => (await db.get(sql, args)).n;
  const weekAgo = now - 7 * DAY_MS;

  const access = settings.access();
  const accounts = {
    total: await one('SELECT COUNT(*) AS n FROM accounts'),
    mode: access.mode,
    limit: access.mode === 'open' && Number.isFinite(access.maxAccounts) ? access.maxAccounts : null,
    newThisWeek: await one('SELECT COUNT(*) AS n FROM accounts WHERE created_at > $1', weekAgo),
    usedThisWeek: (await db.get(`SELECT COUNT(*) AS n FROM accounts a WHERE ${USED_SINCE}`, [weekAgo])).n,
    installed: await one('SELECT COUNT(*) AS n FROM accounts WHERE addon_installed = 1'),
    unused: (await db.get(`SELECT COUNT(*) AS n FROM accounts a WHERE a.created_at <= $1 AND NOT ${USED_SINCE}`,
      [now - UNUSED_DAYS * DAY_MS])).n,
    unusedDays: UNUSED_DAYS,
    // Shared servers remove accounts left unused this long (null: never).
    removeAfterDays: access.mode === 'open' ? settings.get('removeUnusedDays') || null : null,
  };

  const perDay = [];
  for (let i = 6; i >= 0; i--) {
    perDay.push(await one("SELECT COUNT(*) AS n FROM switch_journal WHERE kind = 'switch' AND started_at > $1 AND started_at <= $2",
      now - (i + 1) * DAY_MS, now - i * DAY_MS));
  }
  const switches = {
    perDay,
    week: perDay.reduce((a, b) => a + b, 0),
    today: perDay[6],
    restoresThisWeek: await one("SELECT COUNT(*) AS n FROM switch_journal WHERE kind = 'restore' AND started_at > $1", weekAgo),
    unfinished: await one("SELECT COUNT(*) AS n FROM switch_journal WHERE status = 'open'"),
    rolledBackThisWeek: await one("SELECT COUNT(*) AS n FROM switch_journal WHERE status = 'rolled_back' AND started_at > $1", weekAgo),
  };

  const meta = async (key) => (await db.get('SELECT value FROM meta WHERE key = $1', [key]))?.value ?? null;
  let summary = null;
  try {
    summary = JSON.parse(await meta('last_daily_summary'));
  } catch {
    // never ran, or written by an older version
  }
  const lastDay = await meta('last_daily');
  const daily = {
    lastDay,
    summary,
    snapshots: null,
    // They run once a UTC day, checked hourly: a server up for a day with no run since is behind.
    late: now - startedAt > LATE_MS && (summary == null || now - summary.at > LATE_MS),
  };

  const server = {
    version,
    node: process.version,
    uptimeMs: now - startedAt,
    memory: process.memoryUsage().rss,
    database: null,
    diskFree: null,
    profiles: await one('SELECT COUNT(*) AS n FROM profiles WHERE deleted_at IS NULL'),
    backups: await one('SELECT COUNT(*) AS n FROM backups'),
  };

  const problems = (log.problems?.() ?? []).map(({ level, message, count, last }) => ({ level, message, count, last }));
  return { accounts, switches, daily, server, problems, startedAt };
}
