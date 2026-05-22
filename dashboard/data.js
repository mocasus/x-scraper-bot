/**
 * Framework-agnostic data fetchers for the TUI dashboard.
 *
 * Each public function takes a `deps` object so tests can inject an
 * in-memory database, a stub http client, a synthetic config, and a
 * pinned clock:
 *
 *   deps.db         - object returned by createDb({path}) in bot.js
 *                     (we use deps.db.db, the raw better-sqlite3 handle)
 *   deps.http       - axios-shaped client; only deps.http.get() is used
 *   deps.config     - object returned by loadConfig(env) in bot.js
 *   deps.now        - () => Date  (defaults to Date.now-based clock)
 *   deps.startedAt  - Date or epoch ms when the dashboard started; used
 *                     by getStatus to compute uptimeSeconds
 *
 * Requiring this module has zero side effects: no DB open, no fs.watch,
 * no network calls.
 */

'use strict';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function nowFn(deps) {
  return deps && typeof deps.now === 'function' ? deps.now : () => new Date();
}

function startedAtMs(deps) {
  const s = deps && deps.startedAt;
  if (s instanceof Date) return s.getTime();
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  return null;
}

function colorForState(state) {
  const s = String(state || '').toUpperCase();
  if (s === 'WORKING' || s === 'CONNECTED') return 'green';
  if (s === 'STARTING' || s === 'SCAN_QR_CODE') return 'yellow';
  return 'red';
}

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

/**
 * Hit the WAHA session endpoint and return a dashboard-shaped status
 * blob. Network errors and non-2xx responses both collapse to an
 * UNREACHABLE / red status so the UI can render a single banner.
 *
 * Returns:
 *   {
 *     waha: { state: string, color: 'green'|'yellow'|'red', engine?, me? },
 *     uptimeSeconds: number,         // 0 when startedAt is missing
 *     dashboardStartedAt: Date|null  // echoed for the UI's footer
 *   }
 */
async function getStatus(deps) {
  const d = deps || {};
  const config = d.config || {};
  const http = d.http;
  const now = nowFn(d)();
  const started = startedAtMs(d);
  const dashboardStartedAt = started != null ? new Date(started) : null;
  const uptimeSeconds = started != null
    ? Math.max(0, Math.floor((now.getTime() - started) / 1000))
    : 0;

  let waha;
  try {
    const url = `${config.wahaUrl}/api/sessions/${config.wahaSession}`;
    const res = await http.get(url, { timeout: 5000 });
    const body = (res && res.data) || {};
    const state = body.state || 'UNKNOWN';
    waha = {
      state,
      color: colorForState(state),
    };
    if (body.engine) waha.engine = body.engine;
    if (body.me) waha.me = body.me;
  } catch (_err) {
    waha = { state: 'UNREACHABLE', color: 'red' };
  }

  return { waha, uptimeSeconds, dashboardStartedAt };
}

// ---------------------------------------------------------------------------
// getTodayStats
// ---------------------------------------------------------------------------

/**
 * Count today's scrape activity. SQLite's date('now') is evaluated in
 * UTC; that matches the bot's INSERT default (datetime('now')) so the
 * filter is consistent end-to-end.
 */
function getTodayStats(deps) {
  const db = deps.db.db;
  const row = db
    .prepare(
      "SELECT COUNT(*) AS scraped, COALESCE(SUM(posted_to_whatsapp),0) AS posted " +
        "FROM tweets WHERE date(created_at) = date('now')"
    )
    .get();
  const scraped = row && row.scraped ? Number(row.scraped) : 0;
  const posted = row && row.posted ? Number(row.posted) : 0;
  return { scraped, posted, errors: scraped - posted };
}

// ---------------------------------------------------------------------------
// getHourlyHistogram
// ---------------------------------------------------------------------------

/**
 * Bucket the last 24 hours of tweets by hour-of-day (00..23). Returns
 * two parallel 24-element arrays so the chart widget can plot directly.
 * Hours with no rows are filled with 0.
 */
function getHourlyHistogram(deps) {
  const db = deps.db.db;
  const rows = db
    .prepare(
      "SELECT strftime('%H', created_at) AS hr, COUNT(*) AS n " +
        "FROM tweets WHERE created_at > datetime('now','-24 hours') " +
        'GROUP BY hr ORDER BY hr'
    )
    .all();

  const hours = [];
  const counts = new Array(24).fill(0);
  for (let i = 0; i < 24; i += 1) {
    hours.push(String(i).padStart(2, '0'));
  }
  for (const r of rows) {
    const idx = parseInt(r.hr, 10);
    if (Number.isFinite(idx) && idx >= 0 && idx < 24) {
      counts[idx] = Number(r.n) || 0;
    }
  }
  return { hours, counts };
}

// ---------------------------------------------------------------------------
// getAccountsWithLastSeen
// ---------------------------------------------------------------------------

/**
 * For every configured target account return the timestamp of its most
 * recent tweet (or null if we have never seen one). Output is sorted
 * most-recent-first; never-seen accounts sort last in the order they
 * appear in config.targetAccounts so the UI list is stable.
 */
function getAccountsWithLastSeen(deps) {
  const config = deps.config || {};
  const targets = Array.isArray(config.targetAccounts) ? config.targetAccounts : [];
  const stmt = deps.db.db.prepare(
    'SELECT MAX(created_at) AS last FROM tweets WHERE username = ?'
  );

  const entries = targets.map((username, idx) => {
    const row = stmt.get(username);
    const lastSeen = row && row.last ? row.last : null;
    return { username, lastSeen, _idx: idx };
  });

  entries.sort((a, b) => {
    if (a.lastSeen && b.lastSeen) {
      // descending by timestamp (lexicographic works for ISO/SQLite format)
      if (a.lastSeen < b.lastSeen) return 1;
      if (a.lastSeen > b.lastSeen) return -1;
      return a._idx - b._idx;
    }
    if (a.lastSeen) return -1;
    if (b.lastSeen) return 1;
    return a._idx - b._idx;
  });

  return entries.map((e) => ({ username: e.username, lastSeen: e.lastSeen }));
}

// ---------------------------------------------------------------------------
// getRecentTweets
// ---------------------------------------------------------------------------

/**
 * Return up to `limit` most recent tweets. The limit is clamped to
 * [1, 50]; non-numeric values fall back to 10 (the default). The
 * posted_to_whatsapp column is coerced to a real boolean so the render
 * layer doesn't have to worry about SQLite's 0/1 integers.
 */
function getRecentTweets(deps, limit) {
  let n;
  if (Number.isFinite(limit)) {
    n = Math.floor(limit);
  } else if (limit === undefined) {
    n = 10;
  } else {
    n = 10;
  }
  if (n < 1) n = 1;
  if (n > 50) n = 50;

  const rows = deps.db.db
    .prepare(
      'SELECT username, content, posted_to_whatsapp, created_at ' +
        'FROM tweets ORDER BY created_at DESC LIMIT ?'
    )
    .all(n);

  return rows.map((r) => ({
    username: r.username,
    content: r.content,
    posted_to_whatsapp: Boolean(r.posted_to_whatsapp),
    created_at: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getStatus,
  getTodayStats,
  getHourlyHistogram,
  getAccountsWithLastSeen,
  getRecentTweets,
};
