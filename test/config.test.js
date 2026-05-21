'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../bot.js');

test('loadConfig: defaults when env is empty', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.wahaUrl, 'http://localhost:3000');
  assert.equal(cfg.wahaSession, 'default');
  assert.equal(cfg.wahaChannelId, '');
  assert.deepEqual(cfg.targetAccounts, []);
  assert.deepEqual(cfg.filterKeywords, []);
  assert.equal(cfg.skipReplies, true);
  assert.equal(cfg.skipRetweets, true);
  assert.equal(cfg.checkIntervalMinutes, 5);
  assert.equal(cfg.messageDelayMs, 5000);
  assert.equal(cfg.maxTweetsPerCheck, 5);
  assert.equal(cfg.headless, true);
  assert.equal(cfg.puppeteerExecutablePath, undefined);
});

test('loadConfig: TARGET_ACCOUNTS comma-splits, trims whitespace, strips leading @', () => {
  const cfg = loadConfig({ TARGET_ACCOUNTS: '@elonmusk, @whale_alert ,foo' });
  assert.deepEqual(cfg.targetAccounts, ['elonmusk', 'whale_alert', 'foo']);
});

test('loadConfig: TARGET_ACCOUNTS drops empty entries', () => {
  const cfg = loadConfig({ TARGET_ACCOUNTS: ',,@a,,b,' });
  assert.deepEqual(cfg.targetAccounts, ['a', 'b']);
});

test('loadConfig: FILTER_KEYWORDS lowercased, trimmed, empties dropped', () => {
  const cfg = loadConfig({ FILTER_KEYWORDS: 'Bitcoin, ETH ,,' });
  assert.deepEqual(cfg.filterKeywords, ['bitcoin', 'eth']);
});

test('loadConfig: FILTER_KEYWORDS empty string yields empty array', () => {
  const cfg = loadConfig({ FILTER_KEYWORDS: '' });
  assert.deepEqual(cfg.filterKeywords, []);
});

test('loadConfig: CHECK_INTERVAL_MINUTES clamps at floor=1', () => {
  assert.equal(loadConfig({ CHECK_INTERVAL_MINUTES: '-5' }).checkIntervalMinutes, 1);
  assert.equal(loadConfig({ CHECK_INTERVAL_MINUTES: '0' }).checkIntervalMinutes, 1);
  assert.equal(loadConfig({ CHECK_INTERVAL_MINUTES: '10' }).checkIntervalMinutes, 10);
  assert.equal(loadConfig({ CHECK_INTERVAL_MINUTES: 'abc' }).checkIntervalMinutes, 5);
});

test('loadConfig: MESSAGE_DELAY_MS clamps at floor=1000', () => {
  assert.equal(loadConfig({ MESSAGE_DELAY_MS: '500' }).messageDelayMs, 1000);
  assert.equal(loadConfig({ MESSAGE_DELAY_MS: '5000' }).messageDelayMs, 5000);
  assert.equal(loadConfig({ MESSAGE_DELAY_MS: '' }).messageDelayMs, 5000);
  assert.equal(loadConfig({ MESSAGE_DELAY_MS: '0' }).messageDelayMs, 1000);
});

test('loadConfig: MAX_TWEETS_PER_CHECK clamps at floor=1', () => {
  assert.equal(loadConfig({ MAX_TWEETS_PER_CHECK: '0' }).maxTweetsPerCheck, 1);
  assert.equal(loadConfig({ MAX_TWEETS_PER_CHECK: '-1' }).maxTweetsPerCheck, 1);
  assert.equal(loadConfig({ MAX_TWEETS_PER_CHECK: '20' }).maxTweetsPerCheck, 20);
});

test('loadConfig: SKIP_REPLIES default true, parsed false only for explicit "false"', () => {
  assert.equal(loadConfig({}).skipReplies, true);
  assert.equal(loadConfig({ SKIP_REPLIES: 'true' }).skipReplies, true);
  assert.equal(loadConfig({ SKIP_REPLIES: 'false' }).skipReplies, false);
  // Per current parseBool semantics: anything not "true" (case-insensitive) is false.
  assert.equal(loadConfig({ SKIP_REPLIES: 'no' }).skipReplies, false);
});

test('loadConfig: SKIP_RETWEETS default true, parsed false for explicit "false"', () => {
  assert.equal(loadConfig({}).skipRetweets, true);
  assert.equal(loadConfig({ SKIP_RETWEETS: 'false' }).skipRetweets, false);
  assert.equal(loadConfig({ SKIP_RETWEETS: 'TRUE' }).skipRetweets, true);
});

test('loadConfig: HEADLESS default true, parsed false for explicit "false"', () => {
  assert.equal(loadConfig({}).headless, true);
  assert.equal(loadConfig({ HEADLESS: 'false' }).headless, false);
  assert.equal(loadConfig({ HEADLESS: 'true' }).headless, true);
});

test('loadConfig: puppeteerExecutablePath defaults to undefined', () => {
  assert.equal(loadConfig({}).puppeteerExecutablePath, undefined);
  assert.equal(
    loadConfig({ PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium' }).puppeteerExecutablePath,
    '/usr/bin/chromium'
  );
});

test('loadConfig: WAHA fields override defaults', () => {
  const cfg = loadConfig({
    WAHA_URL: 'http://waha.internal:3000',
    WAHA_SESSION: 'work',
    WAHA_CHANNEL_ID: '999@newsletter',
  });
  assert.equal(cfg.wahaUrl, 'http://waha.internal:3000');
  assert.equal(cfg.wahaSession, 'work');
  assert.equal(cfg.wahaChannelId, '999@newsletter');
});

test('loadConfig: env arg is optional (falls back to process.env)', () => {
  // Just ensure it does not throw and returns a CONFIG-shaped object.
  const cfg = loadConfig();
  assert.ok(typeof cfg.wahaUrl === 'string');
  assert.ok(Array.isArray(cfg.targetAccounts));
  assert.ok(Array.isArray(cfg.filterKeywords));
});
