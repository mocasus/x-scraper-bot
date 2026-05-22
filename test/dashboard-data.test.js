'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getStatus,
  getTodayStats,
  getHourlyHistogram,
  getAccountsWithLastSeen,
  getRecentTweets,
} = require('../dashboard/data.js');

const { inMemoryDb, freshConfig } = require('./helpers/factories.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Insert a row with an explicit created_at timestamp. The bundled
// stmtInsertTweet uses the SQLite default (datetime('now')) so we use a
// fresh prepared statement for every test that needs to seed history.
function seedTweet(db, params) {
  const stmt = db.db.prepare(
    'INSERT INTO tweets (id, username, content, tweet_url, posted_to_whatsapp, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?)'
  );
  stmt.run(
    params.id,
    params.username,
    params.content || `tweet ${params.id}`,
    params.tweet_url || `https://x.com/${params.username}/status/${params.id}`,
    params.posted_to_whatsapp ? 1 : 0,
    params.created_at
  );
}

// Minimal axios-shaped mock with a recordable get(). Resolves with
// `{data}` by default; rejects when `throws` is set.
function mockGet(spec) {
  const cfg = spec || {};
  const calls = [];
  return {
    calls,
    get(url, opts) {
      calls.push({ url, opts });
      if (cfg.throws) return Promise.reject(cfg.throws);
      return Promise.resolve({
        status: cfg.status != null ? cfg.status : 200,
        data: cfg.data != null ? cfg.data : {},
      });
    },
  };
}

// SQLite "YYYY-MM-DD HH:MM:SS" UTC formatter; matches the format used
// by datetime('now') so date(created_at) = date('now') compares equal.
function sqlDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// getTodayStats
// ---------------------------------------------------------------------------

test('getTodayStats returns zeroes on an empty database', () => {
  const db = inMemoryDb();
  try {
    const stats = getTodayStats({ db });
    assert.deepEqual(stats, { scraped: 0, posted: 0, errors: 0 });
  } finally {
    db.close();
  }
});

test('getTodayStats counts today rows and computes errors = scraped - posted', () => {
  const db = inMemoryDb();
  try {
    const today = sqlDate(new Date()); // matches datetime('now') format
    seedTweet(db, { id: '1', username: 'a', posted_to_whatsapp: 1, created_at: today });
    seedTweet(db, { id: '2', username: 'a', posted_to_whatsapp: 1, created_at: today });
    seedTweet(db, { id: '3', username: 'a', posted_to_whatsapp: 0, created_at: today });
    const stats = getTodayStats({ db });
    assert.deepEqual(stats, { scraped: 3, posted: 2, errors: 1 });
  } finally {
    db.close();
  }
});

test('getTodayStats excludes rows from yesterday and 8 days ago', () => {
  const db = inMemoryDb();
  try {
    const now = new Date();
    const today = sqlDate(now);
    const yesterday = sqlDate(new Date(now.getTime() - 24 * 3600 * 1000));
    const eightDays = sqlDate(new Date(now.getTime() - 8 * 24 * 3600 * 1000));
    seedTweet(db, { id: '1', username: 'a', posted_to_whatsapp: 1, created_at: today });
    seedTweet(db, { id: '2', username: 'a', posted_to_whatsapp: 1, created_at: yesterday });
    seedTweet(db, { id: '3', username: 'a', posted_to_whatsapp: 0, created_at: eightDays });
    const stats = getTodayStats({ db });
    assert.deepEqual(stats, { scraped: 1, posted: 1, errors: 0 });
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// getHourlyHistogram
// ---------------------------------------------------------------------------

test('getHourlyHistogram returns 24 zero buckets on empty DB', () => {
  const db = inMemoryDb();
  try {
    const { hours, counts } = getHourlyHistogram({ db });
    assert.equal(hours.length, 24);
    assert.equal(counts.length, 24);
    assert.deepEqual(hours, [
      '00','01','02','03','04','05','06','07','08','09','10','11',
      '12','13','14','15','16','17','18','19','20','21','22','23',
    ]);
    assert.equal(counts.reduce((a, b) => a + b, 0), 0);
  } finally {
    db.close();
  }
});

test('getHourlyHistogram buckets rows by hour and zero-fills missing hours', () => {
  const db = inMemoryDb();
  try {
    // Build today-at-HH timestamps within the last 24 hours window.
    // Using the current date keeps the rows inside `created_at >
    // datetime('now','-24 hours')` regardless of when the test runs.
    const now = new Date();
    function atHour(hour) {
      const d = new Date(now);
      d.setUTCHours(hour, 30, 0, 0); // :30 to dodge boundary rounding
      // If that timestamp is in the future, push back a day so we
      // stay inside the 24h window.
      if (d.getTime() > now.getTime() - 60 * 1000) {
        d.setUTCDate(d.getUTCDate() - 1);
      }
      return sqlDate(d);
    }
    seedTweet(db, { id: '1', username: 'a', posted_to_whatsapp: 0, created_at: atHour(3) });
    seedTweet(db, { id: '2', username: 'a', posted_to_whatsapp: 0, created_at: atHour(3) });
    seedTweet(db, { id: '3', username: 'a', posted_to_whatsapp: 0, created_at: atHour(14) });

    const { counts } = getHourlyHistogram({ db });
    assert.equal(counts[3], 2, 'hour 03 should have 2 rows');
    assert.equal(counts[14], 1, 'hour 14 should have 1 row');
    let zeros = 0;
    for (let i = 0; i < 24; i += 1) if (counts[i] === 0) zeros += 1;
    assert.equal(zeros, 22, 'all other hours should be zero');
  } finally {
    db.close();
  }
});

test('getHourlyHistogram excludes rows older than 24 hours', () => {
  const db = inMemoryDb();
  try {
    // Two days ago at hour 05 - must be excluded.
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    old.setUTCHours(5, 0, 0, 0);
    seedTweet(db, { id: '1', username: 'a', posted_to_whatsapp: 0, created_at: sqlDate(old) });

    const { counts } = getHourlyHistogram({ db });
    assert.equal(counts.reduce((a, b) => a + b, 0), 0);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// getAccountsWithLastSeen
// ---------------------------------------------------------------------------

test('getAccountsWithLastSeen returns null lastSeen for every target on empty DB', () => {
  const db = inMemoryDb();
  try {
    const config = freshConfig({ TARGET_ACCOUNTS: 'a,b,c' });
    const out = getAccountsWithLastSeen({ db, config });
    assert.equal(out.length, 3);
    for (const e of out) assert.equal(e.lastSeen, null);
    // never-seen accounts retain config order.
    assert.deepEqual(out.map((e) => e.username), ['a', 'b', 'c']);
  } finally {
    db.close();
  }
});

test('getAccountsWithLastSeen sorts seen accounts most-recent first, never-seen last', () => {
  const db = inMemoryDb();
  try {
    const config = freshConfig({ TARGET_ACCOUNTS: 'a,b,c' });
    seedTweet(db, {
      id: '1', username: 'a', posted_to_whatsapp: 1,
      created_at: '2024-01-15 09:00:00',
    });
    seedTweet(db, {
      id: '2', username: 'c', posted_to_whatsapp: 1,
      created_at: '2024-01-15 10:00:00',
    });
    const out = getAccountsWithLastSeen({ db, config });
    assert.equal(out.length, 3);
    assert.equal(out[0].username, 'c'); // most recent
    assert.equal(out[1].username, 'a');
    assert.equal(out[2].username, 'b'); // never-seen sorts last
    assert.equal(out[2].lastSeen, null);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// getRecentTweets
// ---------------------------------------------------------------------------

test('getRecentTweets returns [] on empty DB', () => {
  const db = inMemoryDb();
  try {
    assert.deepEqual(getRecentTweets({ db }), []);
  } finally {
    db.close();
  }
});

test('getRecentTweets returns 10 most recent rows in DESC order by default', () => {
  const db = inMemoryDb();
  try {
    for (let i = 0; i < 12; i += 1) {
      // Pad the minute so lexicographic sort matches numeric order.
      const ts = `2024-01-15 12:${String(i).padStart(2, '0')}:00`;
      seedTweet(db, {
        id: String(i),
        username: 'a',
        content: `c${i}`,
        posted_to_whatsapp: 0,
        created_at: ts,
      });
    }
    const rows = getRecentTweets({ db });
    assert.equal(rows.length, 10);
    // Newest (id 11) should be first.
    assert.equal(rows[0].content, 'c11');
    assert.equal(rows[9].content, 'c2');
  } finally {
    db.close();
  }
});

test('getRecentTweets coerces posted_to_whatsapp to a real boolean', () => {
  const db = inMemoryDb();
  try {
    seedTweet(db, {
      id: '1', username: 'a', posted_to_whatsapp: 1, created_at: '2024-01-15 12:00:00',
    });
    seedTweet(db, {
      id: '2', username: 'a', posted_to_whatsapp: 0, created_at: '2024-01-15 12:01:00',
    });
    const rows = getRecentTweets({ db });
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(typeof r.posted_to_whatsapp, 'boolean');
    }
    // Ordered DESC, so id=2 (posted=0 -> false) comes first.
    assert.equal(rows[0].posted_to_whatsapp, false);
    assert.equal(rows[1].posted_to_whatsapp, true);
  } finally {
    db.close();
  }
});

test('getRecentTweets clamps limit into [1, 50]', () => {
  const db = inMemoryDb();
  try {
    for (let i = 0; i < 60; i += 1) {
      const ts = `2024-01-15 12:${String(i % 60).padStart(2, '0')}:00`;
      seedTweet(db, {
        id: String(i), username: 'a', posted_to_whatsapp: 0, created_at: ts,
      });
    }
    assert.equal(getRecentTweets({ db }, -1).length, 1);
    assert.equal(getRecentTweets({ db }, 0).length, 1);
    assert.equal(getRecentTweets({ db }, 100).length, 50);
    assert.equal(getRecentTweets({ db }, 'oops').length, 10); // non-numeric -> default 10
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test("getStatus maps CONNECTED to color 'green' and surfaces engine/me", async () => {
  const config = freshConfig({ WAHA_URL: 'http://waha.example' });
  const http = mockGet({ data: { state: 'CONNECTED', engine: 'WEBJS', me: { phone: '15551234' } } });
  const startedAt = new Date(Date.now() - 5_000);
  const out = await getStatus({ config, http, startedAt });
  assert.equal(out.waha.state, 'CONNECTED');
  assert.equal(out.waha.color, 'green');
  assert.equal(out.waha.engine, 'WEBJS');
  assert.deepEqual(out.waha.me, { phone: '15551234' });
  // The endpoint URL is built from config.
  assert.match(http.calls[0].url, /\/api\/sessions\/default$/);
  assert.equal(http.calls[0].opts.timeout, 5000);
});

test("getStatus maps STARTING to color 'yellow'", async () => {
  const config = freshConfig({ WAHA_URL: 'http://waha.example' });
  const http = mockGet({ data: { state: 'STARTING' } });
  const out = await getStatus({ config, http, startedAt: Date.now() });
  assert.equal(out.waha.state, 'STARTING');
  assert.equal(out.waha.color, 'yellow');
});

test("getStatus maps unknown states to color 'red'", async () => {
  const config = freshConfig({ WAHA_URL: 'http://waha.example' });
  const http = mockGet({ data: { state: 'WHO_KNOWS' } });
  const out = await getStatus({ config, http, startedAt: Date.now() });
  assert.equal(out.waha.state, 'WHO_KNOWS');
  assert.equal(out.waha.color, 'red');
});

test('getStatus collapses http errors to UNREACHABLE/red', async () => {
  const config = freshConfig({ WAHA_URL: 'http://waha.example' });
  const http = mockGet({ throws: new Error('ECONNREFUSED') });
  const out = await getStatus({ config, http, startedAt: Date.now() });
  assert.equal(out.waha.state, 'UNREACHABLE');
  assert.equal(out.waha.color, 'red');
});

test('getStatus computes uptimeSeconds against injected startedAt and now', async () => {
  const config = freshConfig({ WAHA_URL: 'http://waha.example' });
  const http = mockGet({ data: { state: 'CONNECTED' } });
  const startedAt = new Date('2024-01-15T12:00:00Z');
  const fakeNow = new Date('2024-01-15T12:00:42Z');
  const out = await getStatus({
    config, http, startedAt, now: () => fakeNow,
  });
  assert.equal(out.uptimeSeconds, 42);
  assert.ok(out.uptimeSeconds > 0);
  assert.ok(out.dashboardStartedAt instanceof Date);
});
