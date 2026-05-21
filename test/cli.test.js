'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
