'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatRelativeTime,
  truncate,
  colorForLevel,
  formatTweetRow,
} = require('../dashboard/render.js');

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

test("formatRelativeTime returns 'never' for null and undefined", () => {
  const now = new Date('2024-01-15T12:00:00Z');
  assert.equal(formatRelativeTime(null, now), 'never');
  assert.equal(formatRelativeTime(undefined, now), 'never');
});

test("formatRelativeTime returns 'just now' when diff < 60s", () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const just = new Date('2024-01-15T11:59:59Z');
  const earlier = new Date('2024-01-15T11:59:01Z');
  assert.equal(formatRelativeTime(just, now), 'just now');
  assert.equal(formatRelativeTime(earlier, now), 'just now');
});

test("formatRelativeTime returns 'Nm' for 5min and 59min", () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const fiveMin = new Date('2024-01-15T11:55:00Z');
  const fiftyNineMin = new Date('2024-01-15T11:01:00Z');
  assert.equal(formatRelativeTime(fiveMin, now), '5m');
  assert.equal(formatRelativeTime(fiftyNineMin, now), '59m');
});

test("formatRelativeTime returns 'Nh' for 2h and 23h", () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const twoHours = new Date('2024-01-15T10:00:00Z');
  const twentyThreeHours = new Date('2024-01-14T13:00:00Z');
  assert.equal(formatRelativeTime(twoHours, now), '2h');
  assert.equal(formatRelativeTime(twentyThreeHours, now), '23h');
});

test("formatRelativeTime returns 'Nd' for 1d and 7d", () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const oneDay = new Date('2024-01-14T12:00:00Z');
  const sevenDays = new Date('2024-01-08T12:00:00Z');
  assert.equal(formatRelativeTime(oneDay, now), '1d');
  assert.equal(formatRelativeTime(sevenDays, now), '7d');
});

test('formatRelativeTime accepts both Date and ISO strings equivalently', () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const iso = '2024-01-15T11:30:00Z';
  const date = new Date(iso);
  assert.equal(formatRelativeTime(iso, now), formatRelativeTime(date, now));
  assert.equal(formatRelativeTime(iso, now), '30m');
});

test("formatRelativeTime clamps future timestamps to 'just now'", () => {
  const now = new Date('2024-01-15T12:00:00Z');
  const future = new Date('2024-01-15T13:00:00Z');
  assert.equal(formatRelativeTime(future, now), 'just now');
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

test('truncate returns input unchanged when shorter than n', () => {
  assert.equal(truncate('hi', 10), 'hi');
});

test('truncate returns input unchanged when length equals n exactly', () => {
  assert.equal(truncate('hello', 5), 'hello');
});

test('truncate slices and appends single-char ellipsis when longer than n', () => {
  const out = truncate('hello world', 8);
  assert.equal(out, 'hello w\u2026');
  assert.equal(Array.from(out).length, 8);
});

test('truncate does not split multi-byte characters', () => {
  // 'h\u00e9llo\u2603' - 6 code points (h, é, l, l, o, snowman)
  const input = 'h\u00e9llo\u2603';
  assert.equal(Array.from(input).length, 6);
  // truncate to 4: should be 3 chars + ellipsis, total 4 code points
  const out = truncate(input, 4);
  assert.equal(Array.from(out).length, 4);
  assert.equal(out, 'h\u00e9l\u2026');
});

test('truncate does not split surrogate-pair emoji', () => {
  // 'a\ud83d\ude00b' - 3 code points (a, grinning face, b)
  const input = 'a\ud83d\ude00b';
  assert.equal(Array.from(input).length, 3);
  // truncate to 2: 1 char + ellipsis. The emoji must not be split.
  const out = truncate(input, 2);
  assert.equal(Array.from(out).length, 2);
  assert.equal(out, 'a\u2026');
});

// ---------------------------------------------------------------------------
// colorForLevel
// ---------------------------------------------------------------------------

test("colorForLevel maps info (any case) to 'white'", () => {
  assert.equal(colorForLevel('info'), 'white');
  assert.equal(colorForLevel('INFO'), 'white');
});

test("colorForLevel maps warn (any case) to 'yellow'", () => {
  assert.equal(colorForLevel('warn'), 'yellow');
  assert.equal(colorForLevel('WARN'), 'yellow');
});

test("colorForLevel maps error (any case) to 'red-fg'", () => {
  assert.equal(colorForLevel('error'), 'red-fg');
  assert.equal(colorForLevel('ERROR'), 'red-fg');
});

test("colorForLevel falls back to 'gray' for debug or unknown levels", () => {
  assert.equal(colorForLevel('debug'), 'gray');
  assert.equal(colorForLevel('trace'), 'gray');
  assert.equal(colorForLevel(''), 'gray');
  assert.equal(colorForLevel(undefined), 'gray');
});

// ---------------------------------------------------------------------------
// formatTweetRow
// ---------------------------------------------------------------------------

test("formatTweetRow starts with 'OK' when posted_to_whatsapp is truthy", () => {
  const row = formatTweetRow(
    { username: 'elonmusk', content: 'hello', posted_to_whatsapp: 1 },
    60
  );
  assert.ok(row.startsWith('OK '), `expected leading 'OK ', got: ${row}`);
  assert.match(row, /@elonmusk/);
});

test("formatTweetRow starts with '--' when posted_to_whatsapp is 0", () => {
  const row = formatTweetRow(
    { username: 'elonmusk', content: 'hello', posted_to_whatsapp: 0 },
    60
  );
  assert.ok(row.startsWith('-- '), `expected leading '-- ', got: ${row}`);
});

test('formatTweetRow truncates content to fit within width', () => {
  const long = 'a'.repeat(200);
  const row = formatTweetRow(
    { username: 'someone', content: long, posted_to_whatsapp: 0 },
    30
  );
  // Total visible length should be <= 30 code points.
  assert.ok(Array.from(row).length <= 30, `row too long: ${row.length}`);
  // Last char should be the ellipsis (we definitely truncated 200 chars).
  assert.ok(row.endsWith('\u2026'), `expected trailing ellipsis, got: ${row}`);
});
