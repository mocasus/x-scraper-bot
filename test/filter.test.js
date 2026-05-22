'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { filterTweets } = require('../bot.js');
const { freshConfig, inMemoryDb } = require('./helpers/factories.js');

function tweet(overrides) {
  return {
    text: 'hello world',
    time: '2024-01-01T00:00:00.000Z',
    href: 'https://x.com/elonmusk/status/1000',
    isRetweet: false,
    isReply: false,
    ...overrides,
  };
}

test('filterTweets: drops tweets with no href', () => {
  const db = inMemoryDb();
  const config = freshConfig();
  const out = filterTweets([tweet({ href: null })], 'elonmusk', { db, config });
  assert.equal(out.length, 0);
  db.close();
});

test('filterTweets: drops tweets with no text', () => {
  const db = inMemoryDb();
  const config = freshConfig();
  const out = filterTweets([tweet({ text: '' })], 'elonmusk', { db, config });
  assert.equal(out.length, 0);
  db.close();
});

test('filterTweets: SKIP_REPLIES=true drops replies', () => {
  const db = inMemoryDb();
  const config = freshConfig({ SKIP_REPLIES: 'true' });
  const out = filterTweets([tweet({ isReply: true })], 'elonmusk', { db, config });
  assert.equal(out.length, 0);
  db.close();
});

test('filterTweets: SKIP_REPLIES=false keeps replies', () => {
  const db = inMemoryDb();
  const config = freshConfig({ SKIP_REPLIES: 'false', SKIP_RETWEETS: 'false' });
  const out = filterTweets([tweet({ isReply: true })], 'elonmusk', { db, config });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '1000');
  db.close();
});

test('filterTweets: SKIP_RETWEETS=true drops retweets', () => {
  const db = inMemoryDb();
  const config = freshConfig({ SKIP_RETWEETS: 'true' });
  const out = filterTweets(
    [tweet({ isRetweet: true })],
    'elonmusk',
    { db, config }
  );
  assert.equal(out.length, 0);
  db.close();
});

test('filterTweets: SKIP_RETWEETS=false keeps retweets', () => {
  const db = inMemoryDb();
  const config = freshConfig({ SKIP_RETWEETS: 'false' });
  const out = filterTweets(
    [tweet({ isRetweet: true })],
    'elonmusk',
    { db, config }
  );
  assert.equal(out.length, 1);
  db.close();
});

test('filterTweets: SKIP_RETWEETS=true drops cross-account hrefs (path username mismatch)', () => {
  const db = inMemoryDb();
  const config = freshConfig({ SKIP_RETWEETS: 'true' });
  const out = filterTweets(
    [tweet({ href: 'https://x.com/someoneElse/status/2000' })],
    'elonmusk',
    { db, config }
  );
  assert.equal(out.length, 0);
  db.close();
});

test('filterTweets: SKIP_RETWEETS=false keeps cross-account hrefs', () => {
  const db = inMemoryDb();
  const config = freshConfig({ SKIP_RETWEETS: 'false' });
  const out = filterTweets(
    [tweet({ href: 'https://x.com/someoneElse/status/2000' })],
    'elonmusk',
    { db, config }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '2000');
  db.close();
});

test('filterTweets: empty FILTER_KEYWORDS applies no keyword filter', () => {
  const db = inMemoryDb();
  const config = freshConfig();
  const out = filterTweets(
    [tweet({ text: 'totally unrelated text' })],
    'elonmusk',
    { db, config }
  );
  assert.equal(out.length, 1);
  db.close();
});

test('filterTweets: FILTER_KEYWORDS keeps tweets containing keyword (case-insensitive)', () => {
  const db = inMemoryDb();
  const config = freshConfig({ FILTER_KEYWORDS: 'bitcoin' });
  const out = filterTweets(
    [
      tweet({ href: 'https://x.com/elonmusk/status/3001', text: 'BITCOIN soaring' }),
      tweet({ href: 'https://x.com/elonmusk/status/3002', text: 'bitcoin price' }),
      tweet({ href: 'https://x.com/elonmusk/status/3003', text: 'just lunch' }),
    ],
    'elonmusk',
    { db, config }
  );
  assert.equal(out.length, 2);
  const ids = out.map((t) => t.id).sort();
  assert.deepEqual(ids, ['3001', '3002']);
  db.close();
});

test('filterTweets: FILTER_KEYWORDS OR-matches across multiple keywords', () => {
  const db = inMemoryDb();
  const config = freshConfig({ FILTER_KEYWORDS: 'btc,eth' });
  const out = filterTweets(
    [
      tweet({ href: 'https://x.com/elonmusk/status/4001', text: 'BTC pump' }),
      tweet({ href: 'https://x.com/elonmusk/status/4002', text: 'ETH merge' }),
      tweet({ href: 'https://x.com/elonmusk/status/4003', text: 'no match here' }),
    ],
    'elonmusk',
    { db, config }
  );
  assert.equal(out.length, 2);
  db.close();
});

test('filterTweets: tweet already posted (posted_to_whatsapp=1) is dropped', () => {
  const db = inMemoryDb();
  const config = freshConfig();
  // Pre-seed the DB with a posted row.
  db.stmtInsertTweet.run('5001', 'elonmusk', 'old', 'https://x.com/elonmusk/status/5001');
  db.stmtMarkPosted.run('5001');

  const out = filterTweets(
    [tweet({ href: 'https://x.com/elonmusk/status/5001' })],
    'elonmusk',
    { db, config }
  );
  assert.equal(out.length, 0);
  db.close();
});

test('filterTweets: PR #1 retry invariant - posted_to_whatsapp=0 row is NOT skipped', () => {
  const db = inMemoryDb();
  const config = freshConfig();
  // Pre-seed the DB with a row that was inserted but never marked posted
  // (i.e. the previous send failed / process crashed mid-post).
  db.stmtInsertTweet.run('6001', 'elonmusk', 'pending', 'https://x.com/elonmusk/status/6001');
  // Sanity: row is in the DB but posted=0
  const row = db.db.prepare('SELECT posted_to_whatsapp FROM tweets WHERE id = ?').get('6001');
  assert.equal(row.posted_to_whatsapp, 0);

  const out = filterTweets(
    [tweet({ href: 'https://x.com/elonmusk/status/6001', text: 'pending' })],
    'elonmusk',
    { db, config }
  );
  assert.equal(out.length, 1, 'tweet with posted=0 must round-trip into kept');
  assert.equal(out[0].id, '6001');
  db.close();
});

test('filterTweets: returns at most CONFIG.maxTweetsPerCheck items', () => {
  const db = inMemoryDb();
  const config = freshConfig({ MAX_TWEETS_PER_CHECK: '2' });
  const candidates = [];
  for (let i = 0; i < 10; i++) {
    candidates.push(
      tweet({
        href: `https://x.com/elonmusk/status/${7000 + i}`,
        time: `2024-01-01T00:00:0${i}.000Z`,
      })
    );
  }
  const out = filterTweets(candidates, 'elonmusk', { db, config });
  assert.equal(out.length, 2);
  db.close();
});

test('filterTweets: returned items sorted oldest-first by time', () => {
  const db = inMemoryDb();
  const config = freshConfig({ MAX_TWEETS_PER_CHECK: '5' });
  const out = filterTweets(
    [
      tweet({
        href: 'https://x.com/elonmusk/status/8003',
        time: '2024-01-01T00:00:30.000Z',
      }),
      tweet({
        href: 'https://x.com/elonmusk/status/8001',
        time: '2024-01-01T00:00:10.000Z',
      }),
      tweet({
        href: 'https://x.com/elonmusk/status/8002',
        time: '2024-01-01T00:00:20.000Z',
      }),
    ],
    'elonmusk',
    { db, config }
  );
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((t) => t.id),
    ['8001', '8002', '8003']
  );
  db.close();
});

test('filterTweets: kept items carry username, content, tweet_url, time', () => {
  const db = inMemoryDb();
  const config = freshConfig();
  const out = filterTweets(
    [
      tweet({
        href: 'https://x.com/elonmusk/status/9001',
        text: 'hello',
        time: '2024-02-02T02:02:02.000Z',
      }),
    ],
    'ElonMusk',
    { db, config }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].username, 'elonmusk', 'username is lowercased');
  assert.equal(out[0].content, 'hello');
  assert.equal(out[0].tweet_url, 'https://x.com/elonmusk/status/9001');
  assert.equal(out[0].time, '2024-02-02T02:02:02.000Z');
  db.close();
});
