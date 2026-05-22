/**
 * Pure render helpers for the TUI dashboard.
 *
 * Every function here is synchronous, side-effect free, and framework
 * agnostic. The terminal UI in dashboard/index.js consumes the strings
 * these helpers return; nothing in this file imports a UI framework.
 *
 * Requiring this module has zero side effects.
 */

'use strict';

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

/**
 * Render a coarse "N units ago" label suitable for a single-line cell.
 *
 *   null/undefined    -> 'never'
 *   diff < 60s        -> 'just now'   (also when date is in the future)
 *   diff < 3600s      -> 'Nm'
 *   diff < 86400s     -> 'Nh'
 *   else              -> 'Nd'
 *
 * Accepts either a Date instance or anything Date can parse (ISO string,
 * epoch ms number). Unparseable values are treated like null and yield
 * 'never'.
 */
function formatRelativeTime(date, now) {
  if (date === null || date === undefined) return 'never';

  const nowDate = now instanceof Date ? now : now ? new Date(now) : new Date();
  const target = date instanceof Date ? date : new Date(date);
  const targetMs = target.getTime();
  if (!Number.isFinite(targetMs)) return 'never';

  const diffSeconds = Math.floor((nowDate.getTime() - targetMs) / 1000);
  if (diffSeconds < 60) return 'just now';
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h`;
  return `${Math.floor(diffSeconds / 86400)}d`;
}

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

/**
 * Truncate a string to at most n display code points, appending a single
 * U+2026 HORIZONTAL ELLIPSIS when shortening occurs. Operates on Unicode
 * code points (via Array.from) so multi-byte characters and surrogate
 * pairs are never split mid-codepoint.
 *
 * Edge cases:
 *   - n <= 0          -> '' (degenerate but defined)
 *   - non-string str  -> coerced via String()
 */
function truncate(str, n) {
  const s = str === null || str === undefined ? '' : String(str);
  const limit = Number.isFinite(n) ? Math.floor(n) : 0;
  if (limit <= 0) return '';

  const chars = Array.from(s);
  if (chars.length <= limit) return s;
  return chars.slice(0, limit - 1).join('') + '\u2026';
}

// ---------------------------------------------------------------------------
// colorForLevel
// ---------------------------------------------------------------------------

/**
 * Map a log level to a UI color tag string. The returned value is a
 * plain string; it is the caller's responsibility to wrap it in markup
 * or use it as a foreground style. Unknown levels fall through to gray
 * so noisy debug lines don't accidentally render as errors.
 */
function colorForLevel(level) {
  const lvl = String(level || '').toLowerCase();
  if (lvl === 'info') return 'white';
  if (lvl === 'warn') return 'yellow';
  if (lvl === 'error') return 'red-fg';
  return 'gray';
}

// ---------------------------------------------------------------------------
// formatTweetRow
// ---------------------------------------------------------------------------

/**
 * Render a single tweet as a fixed-prefix line for the recent-tweets
 * table. Layout:
 *
 *   "OK @username content..."   when posted_to_whatsapp is truthy
 *   "-- @username content..."   otherwise
 *
 * The 3-character status prefix and "@username " segment are preserved
 * verbatim; only the content portion is truncated so the total line
 * length never exceeds `width`. If `width` is too small to fit the
 * prefix and username at all, the content portion is dropped entirely
 * and the prefix is returned as-is (truncate handles n<=0 by returning
 * the empty string).
 */
function formatTweetRow(tweet, width) {
  const w = Number.isFinite(width) ? Math.floor(width) : 60;
  const t = tweet || {};
  const status = t.posted_to_whatsapp ? 'OK ' : '-- ';
  const handle = `@${t.username || ''} `;
  const prefix = status + handle;
  const remaining = w - prefix.length;
  const content = truncate(t.content || '', remaining);
  return prefix + content;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  formatRelativeTime,
  truncate,
  colorForLevel,
  formatTweetRow,
};
