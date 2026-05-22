'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { postToWhatsApp, filterTweets, formatMessage } = require('../bot.js');
const {
  freshConfig,
  inMemoryDb,
  silentLogger,
  readLogLines,
  mockHttp,
} = require('./helpers/factories.js');

const TWEET = {
  id: '12345',
  username: 'elonmusk',
  content: 'GM',
  tweet_url: 'https://x.com/elonmusk/status/12345',
  time: '2024-01-01T00:00:00.000Z',
};

test('postToWhatsApp: 2xx response posts and flips posted_to_whatsapp=1', async () => {
  const db = inMemoryDb();
  const config = freshConfig({
    WAHA_URL: 'http://waha.test:3000',
    WAHA_SESSION: 'session-x',
    WAHA_CHANNEL_ID: 'chan-1@newsletter',
  });
  const http = mockHttp({ status: 200, data: { id: 'msg-1' } });
  const { logger } = silentLogger();

  const ok = await postToWhatsApp(TWEET, { db, config, http, log: logger });
  assert.equal(ok, true);

  // Exactly one POST went out.
  assert.equal(http.calls.length, 1);

  // URL is the documented WAHA endpoint.
  assert.equal(http.calls[0].url, 'http://waha.test:3000/api/sendText');

  // Body matches the WAHA contract exactly.
  assert.deepEqual(http.calls[0].body, {
    session: 'session-x',
    chatId: 'chan-1@newsletter',
    text: formatMessage(TWEET),
    linkPreview: false,
  });

  // Timeout option is forwarded.
  assert.equal(http.calls[0].opts.timeout, 30000);

  // Row is inserted and marked posted.
  const row = db.db.prepare('SELECT * FROM tweets WHERE id = ?').get(TWEET.id);
  assert.ok(row, 'row was inserted');
  assert.equal(row.posted_to_whatsapp, 1);
  assert.equal(row.username, 'elonmusk');
  assert.equal(row.content, 'GM');
  assert.equal(row.tweet_url, 'https://x.com/elonmusk/status/12345');
  db.close();
});

test('postToWhatsApp: text body equals formatMessage(tweet) shape', async () => {
  const db = inMemoryDb();
  const config = freshConfig({
    WAHA_CHANNEL_ID: 'chan@newsletter',
  });
  const http = mockHttp({ status: 200 });
  const { logger } = silentLogger();

  await postToWhatsApp(TWEET, { db, config, http, log: logger });
  const expected = `🐦 @elonmusk\n\nGM\n\n🔗 https://x.com/elonmusk/status/12345`;
  assert.equal(http.calls[0].body.text, expected);
  assert.equal(formatMessage(TWEET), expected);
  db.close();
});

test('postToWhatsApp: non-2xx leaves posted_to_whatsapp=0 and logs error', async () => {
  const db = inMemoryDb();
  const config = freshConfig({ WAHA_CHANNEL_ID: 'chan@newsletter' });
  const http = mockHttp({ status: 500, data: { error: 'boom' } });
  const { logger, file } = silentLogger();

  const ok = await postToWhatsApp(TWEET, { db, config, http, log: logger });
  assert.equal(ok, false);

  const row = db.db.prepare('SELECT * FROM tweets WHERE id = ?').get(TWEET.id);
  assert.ok(row, 'row inserted before send');
  assert.equal(row.posted_to_whatsapp, 0, 'posted flag stays at 0 on non-2xx');

  const records = readLogLines(file);
  const errs = records.filter((r) => r.level === 'error');
  assert.ok(errs.length >= 1, 'at least one error was logged');
  assert.ok(
    errs.some((r) => r.tweetId === TWEET.id && r.status === 500),
    'error log includes tweetId and status=500'
  );

  // Round-trip: filterTweets MUST still return this tweet on the next cycle.
  const candidates = [
    {
      text: TWEET.content,
      time: TWEET.time,
      href: TWEET.tweet_url,
      isRetweet: false,
      isReply: false,
    },
  ];
  const kept = filterTweets(candidates, 'elonmusk', { db, config });
  assert.equal(kept.length, 1, 'failed-send row must be retried by filterTweets');
  assert.equal(kept[0].id, TWEET.id);

  db.close();
});

test('postToWhatsApp: network error leaves posted=0 and logs err.message', async () => {
  const db = inMemoryDb();
  const config = freshConfig({ WAHA_CHANNEL_ID: 'chan@newsletter' });
  const networkErr = new Error('ECONNREFUSED 127.0.0.1:1');
  const http = mockHttp({ throws: networkErr });
  const { logger, file } = silentLogger();

  const ok = await postToWhatsApp(TWEET, { db, config, http, log: logger });
  assert.equal(ok, false);

  const row = db.db.prepare('SELECT * FROM tweets WHERE id = ?').get(TWEET.id);
  assert.equal(row.posted_to_whatsapp, 0);

  const records = readLogLines(file);
  const matchingErr = records.find(
    (r) => r.level === 'error' && r.tweetId === TWEET.id
  );
  assert.ok(matchingErr, 'error log entry exists');
  assert.match(matchingErr.message, /ECONNREFUSED/);

  // Round-trip: filterTweets must still return this tweet on the next cycle.
  const candidates = [
    {
      text: TWEET.content,
      time: TWEET.time,
      href: TWEET.tweet_url,
      isRetweet: false,
      isReply: false,
    },
  ];
  const kept = filterTweets(candidates, 'elonmusk', { db, config });
  assert.equal(kept.length, 1);
  db.close();
});

test('postToWhatsApp: axios-style err.response.status is captured in log extras', async () => {
  const db = inMemoryDb();
  const config = freshConfig({ WAHA_CHANNEL_ID: 'chan@newsletter' });
  const httpErr = new Error('Request failed with status code 401');
  httpErr.response = { status: 401, data: { detail: 'unauthorized' } };
  const http = mockHttp({ throws: httpErr });
  const { logger, file } = silentLogger();

  const ok = await postToWhatsApp(TWEET, { db, config, http, log: logger });
  assert.equal(ok, false);

  const records = readLogLines(file);
  const errLog = records.find((r) => r.level === 'error' && r.tweetId === TWEET.id);
  assert.ok(errLog);
  assert.equal(errLog.status, 401);
  assert.deepEqual(errLog.body, { detail: 'unauthorized' });
  db.close();
});
