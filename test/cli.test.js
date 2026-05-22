'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../cli.js');
const pkg = require('../package.json');
const { inMemoryDb, freshConfig, mockHttp } = require('./helpers/factories.js');

// ---------------------------------------------------------------------------
// Lightweight test doubles for `console`-shaped sinks.
// ---------------------------------------------------------------------------

function captureSink() {
  const lines = { log: [], warn: [], error: [] };
  return {
    log: (...args) => lines.log.push(args.join(' ')),
    warn: (...args) => lines.warn.push(args.join(' ')),
    error: (...args) => lines.error.push(args.join(' ')),
    _lines: lines,
  };
}

function captureWritable() {
  const chunks = [];
  return {
    write: (s) => {
      chunks.push(String(s));
      return true;
    },
    text: () => chunks.join(''),
  };
}

// In-memory fs facade used by accountsList/accountsAdd/accountsRemove.
function memFs(initial) {
  const files = { ...(initial || {}) };
  return {
    files,
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return files[p];
    },
    writeFileSync: (p, content) => {
      files[p] = String(content);
    },
  };
}

// ---------------------------------------------------------------------------
// --help and --version
// ---------------------------------------------------------------------------

test('buildProgram exposes --version equal to package.json version', () => {
  const program = cli.buildProgram({ onExit: () => {} });
  assert.equal(program.version(), pkg.version);
  assert.equal(program.version(), '1.0.0');
});

test('buildProgram help text lists every documented subcommand', () => {
  const program = cli.buildProgram({ onExit: () => {} });
  const help = program.helpInformation();
  for (const name of ['start', 'scrape', 'send', 'health', 'stats', 'logs', 'accounts', 'db']) {
    assert.match(help, new RegExp(`\\b${name}\\b`), `help should mention "${name}"`);
  }
});

// ---------------------------------------------------------------------------
// runStartValidate / runStart
// ---------------------------------------------------------------------------

test('runStartValidate flags both missing required env vars', () => {
  const config = freshConfig({ TARGET_ACCOUNTS: '', WAHA_CHANNEL_ID: '' });
  const err = captureWritable();
  const result = cli.runStartValidate({ config, err });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['TARGET_ACCOUNTS', 'WAHA_CHANNEL_ID']);
  assert.match(err.text(), /TARGET_ACCOUNTS/);
  assert.match(err.text(), /WAHA_CHANNEL_ID/);
});

test('runStartValidate passes when both required vars are set', () => {
  const config = freshConfig({
    TARGET_ACCOUNTS: 'elonmusk',
    WAHA_CHANNEL_ID: '123@newsletter',
  });
  const err = captureWritable();
  const result = cli.runStartValidate({ config, err });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.equal(err.text(), '');
});

test('runStart returns 1 without launching scheduler when env is missing', async () => {
  const config = freshConfig({ TARGET_ACCOUNTS: '', WAHA_CHANNEL_ID: '' });
  let started = false;
  const code = await cli.runStart({
    config,
    err: captureWritable(),
    startScheduler: async () => {
      started = true;
    },
  });
  assert.equal(code, 1);
  assert.equal(started, false, 'scheduler must not run on missing env');
});

// ---------------------------------------------------------------------------
// runScrape (dry-run path - never launches puppeteer)
// ---------------------------------------------------------------------------

test('runScrape --dry-run --json prints parsed options and exits 0', async () => {
  const out = captureSink();
  const code = await cli.runScrape({
    username: 'elonmusk',
    options: { dryRun: true, json: true, limit: 3 },
    out,
  });
  assert.equal(code, 0);
  assert.equal(out._lines.log.length, 1);
  const parsed = JSON.parse(out._lines.log[0]);
  assert.deepEqual(parsed, { username: 'elonmusk', limit: 3, json: true, dryRun: true });
});

test('runScrape --dry-run human output mentions the username', async () => {
  const out = captureSink();
  const code = await cli.runScrape({
    username: 'whale_alert',
    options: { dryRun: true },
    out,
  });
  assert.equal(code, 0);
  assert.match(out._lines.log.join('\n'), /whale_alert/);
});

// ---------------------------------------------------------------------------
// runHealth
// ---------------------------------------------------------------------------

test('runHealth returns 0 when WAHA reports CONNECTED', async () => {
  const out = captureSink();
  const http = {
    get: async () => ({
      status: 200,
      data: { state: 'CONNECTED', engine: 'NOWEB', me: { phone: '+1' } },
    }),
  };
  const code = await cli.runHealth({ config: freshConfig(), http, out });
  assert.equal(code, 0);
  assert.match(out._lines.log.join('\n'), /CONNECTED/);
});

test('runHealth returns 1 when state is not CONNECTED', async () => {
  const out = captureSink();
  const http = { get: async () => ({ status: 200, data: { state: 'STARTING' } }) };
  const code = await cli.runHealth({ config: freshConfig(), http, out });
  assert.equal(code, 1);
  assert.match(out._lines.log.join('\n'), /STARTING/);
});

test('runHealth returns 1 and logs the error when http rejects', async () => {
  const err = captureSink();
  const http = {
    get: async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:1');
    },
  };
  const code = await cli.runHealth({
    config: freshConfig(),
    http,
    out: captureSink(),
    err,
  });
  assert.equal(code, 1);
  assert.match(err._lines.error.join('\n'), /ECONNREFUSED/);
});

test('runHealth --json emits JSON on the error path', async () => {
  const out = captureSink();
  const http = {
    get: async () => {
      throw new Error('boom');
    },
  };
  const code = await cli.runHealth({
    config: freshConfig(),
    http,
    out,
    json: true,
  });
  assert.equal(code, 1);
  const parsed = JSON.parse(out._lines.log[0]);
  assert.equal(parsed.error, 'boom');
});

// ---------------------------------------------------------------------------
// runStats
// ---------------------------------------------------------------------------

test('runStats prints zero counts on a fresh in-memory DB and exits 0', async () => {
  const db = inMemoryDb();
  const out = captureSink();
  const code = await cli.runStats({ db, out });
  assert.equal(code, 0);
  const text = out._lines.log.join('\n');
  assert.match(text, /Total tweets tracked: 0/);
  assert.match(text, /Posted to WhatsApp: 0/);
  assert.match(text, /No tweets yet/);
  db.close();
});

test('runStats --json returns a structured payload', async () => {
  const db = inMemoryDb();
  const out = captureSink();
  const code = await cli.runStats({ db, out, json: true });
  assert.equal(code, 0);
  const parsed = JSON.parse(out._lines.log[0]);
  assert.equal(parsed.total, 0);
  assert.equal(parsed.posted, 0);
  assert.deepEqual(parsed.recent, []);
  db.close();
});

test('runStats reports counts after rows are inserted', async () => {
  const db = inMemoryDb();
  db.stmtInsertTweet.run('1', 'a', 't1', 'http://x/a/status/1');
  db.stmtInsertTweet.run('2', 'a', 't2', 'http://x/a/status/2');
  db.stmtMarkPosted.run('1');
  const out = captureSink();
  const code = await cli.runStats({ db, out, json: true });
  assert.equal(code, 0);
  const parsed = JSON.parse(out._lines.log[0]);
  assert.equal(parsed.total, 2);
  assert.equal(parsed.posted, 1);
  assert.equal(parsed.recent.length, 2);
  db.close();
});

// ---------------------------------------------------------------------------
// runSend
// ---------------------------------------------------------------------------

test('runSend posts to WAHA and exits 0 on 2xx', async () => {
  const config = freshConfig({
    WAHA_URL: 'http://waha.test',
    WAHA_SESSION: 's',
    WAHA_CHANNEL_ID: 'chan@newsletter',
  });
  const http = mockHttp({ status: 200, data: { id: 'm1' } });
  const out = captureSink();
  const code = await cli.runSend({
    text: 'hello',
    options: {},
    config,
    http,
    out,
    err: captureSink(),
  });
  assert.equal(code, 0);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, 'http://waha.test/api/sendText');
  assert.deepEqual(http.calls[0].body, {
    session: 's',
    chatId: 'chan@newsletter',
    text: 'hello',
    linkPreview: false,
  });
});

test('runSend uses --channel override when provided', async () => {
  const config = freshConfig({ WAHA_CHANNEL_ID: 'default@newsletter' });
  const http = mockHttp({ status: 200 });
  const code = await cli.runSend({
    text: 'hi',
    options: { channel: 'override@newsletter' },
    config,
    http,
    out: captureSink(),
    err: captureSink(),
  });
  assert.equal(code, 0);
  assert.equal(http.calls[0].body.chatId, 'override@newsletter');
});

test('runSend exits 1 when WAHA_CHANNEL_ID and --channel are both empty', async () => {
  const config = freshConfig({ WAHA_CHANNEL_ID: '' });
  const err = captureSink();
  const code = await cli.runSend({
    text: 'hi',
    options: {},
    config,
    http: mockHttp({ status: 200 }),
    out: captureSink(),
    err,
  });
  assert.equal(code, 1);
  assert.match(err._lines.error.join('\n'), /WAHA_CHANNEL_ID/);
});

test('runSend exits 1 on http rejection', async () => {
  const http = {
    post: async () => {
      throw new Error('ENETDOWN');
    },
  };
  const err = captureSink();
  const code = await cli.runSend({
    text: 'hi',
    options: {},
    config: freshConfig({ WAHA_CHANNEL_ID: 'c@newsletter' }),
    http,
    out: captureSink(),
    err,
  });
  assert.equal(code, 1);
  assert.match(err._lines.error.join('\n'), /ENETDOWN/);
});

// ---------------------------------------------------------------------------
// accounts list / add / remove
// ---------------------------------------------------------------------------

test('accountsList returns parsed array from a synthetic .env', () => {
  const fsMock = memFs({
    '.env': 'TARGET_ACCOUNTS=@elonmusk, @whale_alert ,foo\nOTHER=keep\n',
  });
  const r = cli.accountsList({ envFile: '.env', fs: fsMock, silent: true });
  assert.equal(r.code, 0);
  assert.deepEqual(r.accounts, ['elonmusk', 'whale_alert', 'foo']);
});

test('accountsList against a missing .env file returns empty and code 0', () => {
  const fsMock = memFs({});
  const r = cli.accountsList({
    envFile: '.env',
    fs: fsMock,
    out: captureSink(),
    silent: true,
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.accounts, []);
});

test('accountsAdd appends a new username, deduplicates, and preserves comments', () => {
  const original =
    '# top comment\nTARGET_ACCOUNTS=elonmusk\n# trailing\nOTHER=value\n';
  const fsMock = memFs({ '.env': original });
  const r1 = cli.accountsAdd({
    envFile: '.env',
    fs: fsMock,
    username: '@whale_alert',
    silent: true,
  });
  assert.equal(r1.code, 0);
  assert.deepEqual(r1.accounts, ['elonmusk', 'whale_alert']);

  // Comments and other vars survived the rewrite byte-for-byte.
  const updated = fsMock.files['.env'];
  assert.match(updated, /^# top comment$/m);
  assert.match(updated, /^# trailing$/m);
  assert.match(updated, /^OTHER=value$/m);
  assert.match(updated, /^TARGET_ACCOUNTS=elonmusk,whale_alert$/m);

  // Re-adding is a no-op (and case-insensitive).
  const r2 = cli.accountsAdd({
    envFile: '.env',
    fs: fsMock,
    username: 'WHALE_ALERT',
    silent: true,
  });
  assert.equal(r2.code, 0);
  assert.deepEqual(r2.accounts, ['elonmusk', 'whale_alert']);
});

test('accountsAdd against a missing .env exits 1 with a clear stderr', () => {
  const fsMock = memFs({});
  const err = captureSink();
  const r = cli.accountsAdd({
    envFile: '.env',
    fs: fsMock,
    username: 'foo',
    out: captureSink(),
    err,
    silent: true,
  });
  assert.equal(r.code, 1);
  assert.match(err._lines.error.join('\n'), /\.env/);
});

test('accountsRemove drops the username case-insensitively and rewrites', () => {
  const fsMock = memFs({
    '.env': 'TARGET_ACCOUNTS=elonmusk,whale_alert,foo\n',
  });
  const r = cli.accountsRemove({
    envFile: '.env',
    fs: fsMock,
    username: 'WHALE_ALERT',
    silent: true,
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.accounts, ['elonmusk', 'foo']);
  assert.match(fsMock.files['.env'], /^TARGET_ACCOUNTS=elonmusk,foo$/m);
});

test('accountsRemove of an absent username is a no-op (code 0)', () => {
  const fsMock = memFs({ '.env': 'TARGET_ACCOUNTS=elonmusk\n' });
  const r = cli.accountsRemove({
    envFile: '.env',
    fs: fsMock,
    username: 'nobody',
    silent: true,
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.accounts, ['elonmusk']);
});

// ---------------------------------------------------------------------------
// db migrate / reset
// ---------------------------------------------------------------------------

test('dbMigrate is idempotent and exits 0', () => {
  const db = inMemoryDb();
  const r = cli.dbMigrate({ db, silent: true });
  assert.equal(r.code, 0);
  // schema is still present after migrate
  const row = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tweets'")
    .get();
  assert.ok(row, 'tweets table exists');
  db.close();
});

test('dbReset without --confirm refuses and exits 1', () => {
  const db = inMemoryDb();
  // populate one row so we can confirm it survives the refused reset.
  db.stmtInsertTweet.run('1', 'a', 't', 'http://x/a/status/1');
  const err = captureSink();
  const r = cli.dbReset({ db, confirm: false, err, silent: true });
  assert.equal(r.code, 1);
  assert.match(err._lines.error.join('\n'), /--confirm/);
  const count = db.db.prepare('SELECT COUNT(*) as n FROM tweets').get().n;
  assert.equal(count, 1, 'row survives a refused reset');
  db.close();
});

test('dbReset --confirm drops and recreates the tweets table (empty afterward)', () => {
  const db = inMemoryDb();
  db.stmtInsertTweet.run('1', 'a', 't', 'http://x/a/status/1');
  db.stmtInsertTweet.run('2', 'a', 't2', 'http://x/a/status/2');
  const r = cli.dbReset({ db, confirm: true, silent: true });
  assert.equal(r.code, 0);
  const count = db.db.prepare('SELECT COUNT(*) as n FROM tweets').get().n;
  assert.equal(count, 0, 'tweets table is empty after reset');
  // Schema is back so we can insert again.
  db.db
    .prepare(
      'INSERT INTO tweets (id, username, content, tweet_url, posted_to_whatsapp) VALUES (?, ?, ?, ?, 0)'
    )
    .run('3', 'a', 't3', 'http://x/a/status/3');
  const after = db.db.prepare('SELECT COUNT(*) as n FROM tweets').get().n;
  assert.equal(after, 1);
  db.close();
});

// ---------------------------------------------------------------------------
// formatLogLine
// ---------------------------------------------------------------------------

test('formatLogLine pretty-prints JSON-line records', () => {
  const line = JSON.stringify({
    timestamp: '2024-01-02T03:04:05.000Z',
    level: 'info',
    message: 'hello',
  });
  assert.equal(cli.formatLogLine(line), '[03:04:05] [INFO]: hello');
});

test('formatLogLine returns the raw line on JSON parse failure', () => {
  assert.equal(cli.formatLogLine('not json'), 'not json');
});

// ---------------------------------------------------------------------------
// runLogs ('No logs yet' branch)
// ---------------------------------------------------------------------------

test('runLogs prints "No logs yet" when the log file is missing', async () => {
  const out = captureSink();
  const fakeFs = {
    existsSync: () => false,
    readFileSync: () => '',
    statSync: () => ({ size: 0 }),
  };
  const code = await cli.runLogs({
    fs: fakeFs,
    logFile: '/tmp/nope.log',
    out,
  });
  assert.equal(code, 0);
  assert.deepEqual(out._lines.log, ['No logs yet']);
});

test('runLogs reads the last N lines from the synthetic log file', async () => {
  const records = [
    JSON.stringify({ timestamp: '2024-01-01T00:00:01.000Z', level: 'info', message: 'a' }),
    JSON.stringify({ timestamp: '2024-01-01T00:00:02.000Z', level: 'warn', message: 'b' }),
    JSON.stringify({ timestamp: '2024-01-01T00:00:03.000Z', level: 'error', message: 'c' }),
  ];
  const file = '/tmp/fake-bot.log';
  const fakeFs = {
    existsSync: (p) => p === file,
    readFileSync: () => records.join('\n') + '\n',
    statSync: () => ({ size: 1 }),
  };
  const out = captureSink();
  const code = await cli.runLogs({ fs: fakeFs, logFile: file, lines: 2, out });
  assert.equal(code, 0);
  assert.equal(out._lines.log.length, 2);
  assert.match(out._lines.log[0], /\[WARN\]: b/);
  assert.match(out._lines.log[1], /\[ERROR\]: c/);
});

// ---------------------------------------------------------------------------
// commander program: `--help` is rendered without exiting (we capture via onExit).
// ---------------------------------------------------------------------------

test('buildProgram --version with exitOverride does not call process.exit', async () => {
  const program = cli.buildProgram({ onExit: () => {} });
  // Stub commander's writeOut so the version string doesn't bleed into test stdout.
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
    outputError: () => {},
  });
  // exitOverride converts process.exit(0) into a thrown CommanderError.
  program.exitOverride();
  let caught = null;
  try {
    await program.parseAsync(['--version'], { from: 'user' });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, '--version should throw under exitOverride');
  assert.equal(caught.code, 'commander.version');
});

// Sanity counter so the file documents its own assertion count growth.
test('cli.test.js exposes the documented exports', () => {
  for (const name of [
    'runStart',
    'runStartValidate',
    'runScrape',
    'runSend',
    'runHealth',
    'runStats',
    'runLogs',
    'accountsList',
    'accountsAdd',
    'accountsRemove',
    'dbMigrate',
    'dbReset',
    'buildProgram',
  ]) {
    assert.equal(typeof cli[name], 'function', `cli.${name} is exported as a function`);
  }
});

// ---------------------------------------------------------------------------
// Review v1 follow-ups
// ---------------------------------------------------------------------------

// Issue 7: pin runHealth's request URL to ${wahaUrl}/api/sessions/${wahaSession}.
test('runHealth hits the documented WAHA path with the configured session', async () => {
  const calls = [];
  const http = {
    get: async (url, opts) => {
      calls.push({ url, opts });
      return { status: 200, data: { state: 'CONNECTED' } };
    },
  };
  const config = freshConfig({
    WAHA_URL: 'http://waha.test:9999',
    WAHA_SESSION: 'my-session',
  });
  const code = await cli.runHealth({ config, http, out: captureSink() });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'http://waha.test:9999/api/sessions/my-session',
    'health must call ${wahaUrl}/api/sessions/${wahaSession}'
  );
  assert.equal(calls[0].opts.timeout, 5000);
});

// Issue 3: runStart happy path - validation passes -> startScheduler is invoked
// with the right shape. A regression in the validation->scheduler glue would
// have slipped through with the prior tests.
test('runStart invokes startScheduler with {once,config} when env is valid', async () => {
  const config = freshConfig({
    TARGET_ACCOUNTS: 'elonmusk,whale_alert',
    WAHA_CHANNEL_ID: '123@newsletter',
  });
  const calls = [];
  const fakeScheduler = async (opts) => {
    calls.push(opts);
  };
  const code = await cli.runStart({
    once: true,
    config,
    err: captureWritable(),
    startScheduler: fakeScheduler,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1, 'scheduler should be called exactly once');
  assert.equal(calls[0].once, true);
  assert.equal(calls[0].config, config, 'config is forwarded by reference');
});

test('runStart forwards once=false when --once flag absent', async () => {
  const config = freshConfig({
    TARGET_ACCOUNTS: 'foo',
    WAHA_CHANNEL_ID: 'c@newsletter',
  });
  const calls = [];
  const code = await cli.runStart({
    config,
    err: captureWritable(),
    startScheduler: async (opts) => {
      calls.push(opts);
    },
  });
  assert.equal(code, 0);
  assert.equal(calls[0].once, false);
});

// Issue 4: runScrape puppeteer-launch branch (everything past the dry-run
// guard) had no test coverage. Drive the body with an injected browserFactory
// and a fake scrapeAccount.
test('runScrape success path drives browserFactory + scrapeAccount and prints JSON', async () => {
  const closes = [];
  const fakeBrowser = {
    close: async () => {
      closes.push('browser');
    },
  };
  const factoryCalls = [];
  const browserFactory = async (launchOptions) => {
    factoryCalls.push(launchOptions);
    return fakeBrowser;
  };
  const scrapeCalls = [];
  const fakeScrape = async (browser, username, opts) => {
    scrapeCalls.push({ browser, username, opts });
    return [
      { text: 'one', time: '2024-01-01T00:00:00.000Z', href: 'https://x.com/elonmusk/status/1' },
      { text: 'two', time: '2024-01-02T00:00:00.000Z', href: 'https://x.com/elonmusk/status/2' },
      { text: 'three', time: '2024-01-03T00:00:00.000Z', href: 'https://x.com/elonmusk/status/3' },
    ];
  };
  const out = captureSink();
  const code = await cli.runScrape({
    username: 'elonmusk',
    options: { json: true, limit: 2 },
    config: freshConfig({ HEADLESS: 'true' }),
    browserFactory,
    scrapeAccount: fakeScrape,
    out,
  });
  assert.equal(code, 0);
  assert.equal(factoryCalls.length, 1, 'browserFactory invoked exactly once');
  assert.ok(Array.isArray(factoryCalls[0].args), 'launch args are an array');
  assert.ok(
    factoryCalls[0].args.includes('--no-sandbox'),
    'no-sandbox flag forwarded to puppeteer'
  );
  assert.equal(scrapeCalls.length, 1, 'scrapeAccount invoked exactly once');
  assert.equal(scrapeCalls[0].browser, fakeBrowser);
  assert.equal(scrapeCalls[0].username, 'elonmusk');
  assert.equal(closes.length, 1, 'browser.close() ran in the finally block');
  // --limit 2 truncates the 3-tweet result.
  const parsed = JSON.parse(out._lines.log[0]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].text, 'one');
});

test('runScrape success path prints human-readable lines without --json', async () => {
  const fakeBrowser = { close: async () => {} };
  const out = captureSink();
  const code = await cli.runScrape({
    username: 'whale_alert',
    options: {},
    config: freshConfig(),
    browserFactory: async () => fakeBrowser,
    scrapeAccount: async () => [
      { text: 'hello world', time: '2024-01-01T00:00:00.000Z', href: 'https://x.com/whale_alert/status/9' },
    ],
    out,
  });
  assert.equal(code, 0);
  const text = out._lines.log.join('\n');
  assert.match(text, /\[2024-01-01T00:00:00\.000Z\]/);
  assert.match(text, /https:\/\/x\.com\/whale_alert\/status\/9/);
  assert.match(text, /hello world/);
});

test('runScrape closes the browser even when scrapeAccount throws', async () => {
  let closed = false;
  const fakeBrowser = {
    close: async () => {
      closed = true;
    },
  };
  const err = captureSink();
  const code = await cli.runScrape({
    username: 'foo',
    options: {},
    config: freshConfig(),
    browserFactory: async () => fakeBrowser,
    scrapeAccount: async () => {
      throw new Error('selector timeout');
    },
    out: captureSink(),
    err,
  });
  assert.equal(code, 1);
  assert.equal(closed, true, 'browser must close on scrape failure');
  assert.match(err._lines.error.join('\n'), /selector timeout/);
});

// Issue 1: accounts add must reject usernames that don't match the X handle
// alphabet, otherwise an embedded \n or , gets written into .env verbatim
// and dotenv reads the injected lines as separate env vars on next start.
test('accountsAdd rejects usernames containing newlines (env injection)', () => {
  const fsMock = memFs({ '.env': 'TARGET_ACCOUNTS=elonmusk\n' });
  const err = captureSink();
  const r = cli.accountsAdd({
    envFile: '.env',
    fs: fsMock,
    username: 'foo\nMALICIOUS=1',
    out: captureSink(),
    err,
    silent: true,
  });
  assert.equal(r.code, 1);
  assert.match(err._lines.error.join('\n'), /invalid username/);
  // .env must be untouched by the rejected add.
  assert.equal(fsMock.files['.env'], 'TARGET_ACCOUNTS=elonmusk\n');
});

test('accountsAdd rejects usernames containing commas (account-list injection)', () => {
  const fsMock = memFs({ '.env': 'TARGET_ACCOUNTS=elonmusk\n' });
  const err = captureSink();
  const r = cli.accountsAdd({
    envFile: '.env',
    fs: fsMock,
    username: 'foo,bar',
    out: captureSink(),
    err,
    silent: true,
  });
  assert.equal(r.code, 1);
  assert.match(err._lines.error.join('\n'), /invalid username/);
  assert.equal(fsMock.files['.env'], 'TARGET_ACCOUNTS=elonmusk\n');
});

test('accountsAdd rejects usernames longer than 15 characters', () => {
  const fsMock = memFs({ '.env': 'TARGET_ACCOUNTS=elonmusk\n' });
  const err = captureSink();
  const r = cli.accountsAdd({
    envFile: '.env',
    fs: fsMock,
    username: 'a'.repeat(16),
    err,
    silent: true,
  });
  assert.equal(r.code, 1);
  assert.match(err._lines.error.join('\n'), /invalid username/);
});

test('accountsAdd accepts the full X handle alphabet (letters, digits, underscore)', () => {
  const fsMock = memFs({ '.env': 'TARGET_ACCOUNTS=elonmusk\n' });
  const r = cli.accountsAdd({
    envFile: '.env',
    fs: fsMock,
    username: 'foo_BAR_42',
    silent: true,
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.accounts, ['elonmusk', 'foo_bar_42']);
});

test('accountsRemove also rejects invalid usernames', () => {
  const fsMock = memFs({ '.env': 'TARGET_ACCOUNTS=elonmusk,foo\n' });
  const err = captureSink();
  const r = cli.accountsRemove({
    envFile: '.env',
    fs: fsMock,
    username: 'foo bar',
    err,
    silent: true,
  });
  assert.equal(r.code, 1);
  assert.match(err._lines.error.join('\n'), /invalid username/);
  // No write happened.
  assert.equal(fsMock.files['.env'], 'TARGET_ACCOUNTS=elonmusk,foo\n');
});

// Issue 8: dbReset must use the same schema as createDb. After a reset the
// idx_tweets_username_created index should still be present.
test('dbReset --confirm restores the schema index from createDb', () => {
  const db = inMemoryDb();
  const r = cli.dbReset({ db, confirm: true, silent: true });
  assert.equal(r.code, 0);
  const idx = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tweets_username_created'")
    .get();
  assert.ok(idx, 'idx_tweets_username_created must exist after reset');
  db.close();
});

// Issue 2: dbReset must print a stderr nudge when running against a real DB
// path so an operator who left the scheduler running gets a clear hint.
test('dbReset --confirm prints a stop-the-bot warning for the real-path branch', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbreset-test-'));
  const tmpDb = path.join(tmpDir, 'bot.db');
  const err = captureSink();
  try {
    const r = cli.dbReset({
      confirm: true,
      dbPath: tmpDb,
      err,
      out: captureSink(),
      silent: true,
    });
    assert.equal(r.code, 0);
    const errText = err._lines.error.join('\n');
    assert.match(errText, /scheduler/i, 'warning mentions the scheduler');
    assert.match(errText, /stop it first/i, 'warning tells the operator to stop the bot');
    assert.ok(errText.includes(tmpDb), 'warning includes the actual db path');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
