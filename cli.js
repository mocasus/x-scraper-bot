#!/usr/bin/env node
/**
 * x-scraper CLI: ops surface for the X-to-WhatsApp scraper bot.
 *
 * Subcommands: start, scrape, send, health, stats, logs, accounts (list/add/
 * remove), db (migrate/reset). Each subcommand's body is exported as a plain
 * async function so unit tests can drive it with injected dependencies
 * (http, db, fs, browserFactory, ...) without touching the network or
 * launching puppeteer.
 *
 * Run as a script:   node cli.js <command>
 *                    npx x-scraper <command>
 * Or require:        const { runHealth, runStats, ... } = require('./cli.js')
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Command } = require('commander');

const bot = require('./bot.js');
const pkg = require('./package.json');

const {
  CONFIG: DEFAULT_CONFIG,
  loadConfig,
  createDb,
  formatMessage,
  scrapeAccount,
  startScheduler,
  validateSchedulerEnv,
  SCHEMA_SQL,
} = bot;

// X handle alphabet (mirrors twitter.com's actual rules): letters, digits,
// underscore, 1-15 chars. Used to reject `accounts add/remove` inputs that
// would otherwise let an attacker inject newlines or commas into .env.
const VALID_USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

// ---------------------------------------------------------------------------
// Subcommand implementations - each accepts injected deps for testability.
// They never call process.exit themselves; callers (the commander wrapper or
// tests) decide how to surface the result.
// ---------------------------------------------------------------------------

/**
 * Validate the env required by `start`. Returns {missing, ok}; on missing,
 * also writes the same stderr message that `node bot.js` produces so the UX
 * matches between the two entrypoints.
 */
function runStartValidate(opts) {
  const o = opts || {};
  const config = o.config || DEFAULT_CONFIG;
  const err = o.err || process.stderr;
  const missing = validateSchedulerEnv(config);
  if (missing.length > 0) {
    err.write(
      `❌ Missing required environment variable(s): ${missing.join(', ')}.\n` +
        `   Copy .env.example to .env and fill in the values.\n`
    );
  }
  return { missing, ok: missing.length === 0 };
}

async function runStart(opts) {
  const o = opts || {};
  const config = o.config || DEFAULT_CONFIG;
  const err = o.err || process.stderr;
  const validation = runStartValidate({ config, err });
  if (!validation.ok) return 1;
  const scheduler = o.startScheduler || startScheduler;
  await scheduler({ once: Boolean(o.once), config });
  return 0;
}

async function runScrape(args) {
  const a = args || {};
  const username = a.username;
  const options = a.options || {};
  const out = a.out || console;
  const err = a.err || console;

  if (!username) {
    err.error('scrape: <username> is required');
    return 1;
  }

  const limit =
    options.limit != null && Number.isFinite(Number(options.limit))
      ? Number(options.limit)
      : null;

  if (options.dryRun) {
    const payload = {
      username,
      limit,
      json: Boolean(options.json),
      dryRun: true,
    };
    if (options.json) {
      out.log(JSON.stringify(payload));
    } else {
      out.log(`scrape (dry-run) username=${username} limit=${limit} json=${payload.json}`);
    }
    return 0;
  }

  const config = a.config || DEFAULT_CONFIG;
  const launcher =
    typeof a.browserFactory === 'function'
      ? a.browserFactory
      : // Default: use the puppeteer module that bot.js already loaded.
        // (No lazy-require dance: bot.js top-level requires puppeteer, so by
        // the time we reach this branch the module is already in require.cache.)
        // eslint-disable-next-line global-require
        ((opts) => require('puppeteer').launch(opts));

  const launchOptions = {
    headless: config.headless ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  };
  if (config.puppeteerExecutablePath) {
    launchOptions.executablePath = config.puppeteerExecutablePath;
  }

  let browser = null;
  try {
    browser = await launcher(launchOptions);
    const scraper = a.scrapeAccount || scrapeAccount;
    const tweets = await scraper(browser, username, { config });
    const sliced = limit != null ? tweets.slice(0, limit) : tweets;
    if (options.json) {
      out.log(JSON.stringify(sliced, null, 2));
    } else if (sliced.length === 0) {
      out.log(`No tweets scraped for @${username}`);
    } else {
      sliced.forEach((t, i) => {
        out.log(`${i + 1}. [${t.time || 'no-time'}] ${t.href || ''}`);
        out.log(`   ${(t.text || '').replace(/\n/g, ' ').slice(0, 140)}`);
      });
    }
    return 0;
  } catch (e) {
    err.error(`scrape failed: ${e.message}`);
    return 1;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {
        // ignore close errors
      }
    }
  }
}

async function runSend(args) {
  const a = args || {};
  const text = a.text;
  const options = a.options || {};
  const config = a.config || DEFAULT_CONFIG;
  const http = a.http || axios;
  const out = a.out || console;
  const err = a.err || console;

  if (!text) {
    err.error('send: <text> is required');
    return 1;
  }

  const chatId = options.channel || config.wahaChannelId;
  if (!chatId) {
    err.error('send: WAHA_CHANNEL_ID is empty and --channel was not provided');
    return 1;
  }

  try {
    const response = await http.post(
      `${config.wahaUrl}/api/sendText`,
      {
        session: config.wahaSession,
        chatId,
        text,
        linkPreview: false,
      },
      { timeout: 30000 }
    );
    if (response.status >= 200 && response.status < 300) {
      out.log(`✅ sent to ${chatId} (status=${response.status})`);
      return 0;
    }
    err.error(`send: WAHA returned status=${response.status}`);
    return 1;
  } catch (e) {
    err.error(`send failed: ${e.message}`);
    return 1;
  }
}

async function runHealth(args) {
  const a = args || {};
  const config = a.config || DEFAULT_CONFIG;
  const http = a.http || axios;
  const out = a.out || console;
  const err = a.err || console;
  const json = Boolean(a.json);

  try {
    const response = await http.get(
      `${config.wahaUrl}/api/sessions/${config.wahaSession}`,
      { timeout: 5000 }
    );
    const data = response.data || {};
    const state = data.state || 'UNKNOWN';
    const engine = data.engine || (data.engine === 0 ? 0 : 'unknown');
    const phone = (data.me && data.me.phone) || null;
    if (json) {
      out.log(JSON.stringify({ state, engine, phone, raw: data }, null, 2));
    } else {
      out.log(`state=${state} engine=${engine} phone=${phone || '-'}`);
    }
    return state === 'CONNECTED' ? 0 : 1;
  } catch (e) {
    if (json) {
      out.log(JSON.stringify({ error: e.message }, null, 2));
    } else {
      err.error(`health failed: ${e.message}`);
    }
    return 1;
  }
}

async function runStats(args) {
  const a = args || {};
  const out = a.out || console;
  const json = Boolean(a.json);
  const dbPath = a.dbPath || path.resolve('./data/bot.db');

  let dbDeps;
  if (a.db) {
    dbDeps = a.db;
  } else {
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    dbDeps = createDb({ path: dbPath });
  }

  try {
    const stats = dbDeps.db
      .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(posted_to_whatsapp),0) AS posted FROM tweets')
      .get();
    const recent = dbDeps.db
      .prepare(
        'SELECT id, username, content, posted_to_whatsapp, created_at FROM tweets ORDER BY created_at DESC LIMIT 5'
      )
      .all();

    const total = Number(stats.total || 0);
    const posted = Number(stats.posted || 0);

    if (json) {
      out.log(JSON.stringify({ total, posted, recent }, null, 2));
    } else {
      out.log(`Total tweets tracked: ${total}`);
      out.log(`Posted to WhatsApp: ${posted}`);
      out.log('');
      if (recent.length === 0) {
        out.log('No tweets yet.');
      } else {
        out.log('Recent tweets:');
        recent.forEach((t, i) => {
          const flag = t.posted_to_whatsapp ? '✅' : '⏳';
          const snippet = String(t.content || '').slice(0, 60);
          out.log(`${i + 1}. [${flag}] @${t.username}: ${snippet}`);
        });
      }
    }
    return 0;
  } finally {
    if (!a.db) {
      try {
        dbDeps.close();
      } catch (_) {
        // ignore
      }
    }
  }
}

function formatLogLine(line) {
  try {
    const rec = JSON.parse(line);
    const time = (rec.timestamp || '').split('T')[1]
      ? rec.timestamp.split('T')[1].split('.')[0]
      : (rec.timestamp || '');
    const level = (rec.level || 'info').toUpperCase();
    return `[${time}] [${level}]: ${rec.message || ''}`;
  } catch (_) {
    return line;
  }
}

async function runLogs(args) {
  const a = args || {};
  const out = a.out || console;
  const err = a.err || console;
  const lines = a.lines != null ? a.lines : 50;
  const follow = Boolean(a.follow);
  const logFile = a.logFile || path.resolve('./logs/bot.log');
  const fsDep = a.fs || fs;

  if (!fsDep.existsSync(logFile)) {
    out.log('No logs yet');
    return 0;
  }

  const initial = fsDep
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean);
  const tail = initial.slice(-lines);
  for (const l of tail) out.log(formatLogLine(l));

  if (!follow) return 0;

  // Follow mode: poll for new bytes appended to the file.
  return new Promise((resolve) => {
    let lastSize = fsDep.statSync(logFile).size;
    let leftover = '';
    const intervalMs = a.intervalMs != null ? a.intervalMs : 500;
    const handle = setInterval(() => {
      try {
        const stat = fsDep.statSync(logFile);
        if (stat.size < lastSize) {
          // truncated - reset
          lastSize = 0;
          leftover = '';
        }
        if (stat.size > lastSize) {
          const fd = fsDep.openSync(logFile, 'r');
          const buf = Buffer.alloc(stat.size - lastSize);
          fsDep.readSync(fd, buf, 0, buf.length, lastSize);
          fsDep.closeSync(fd);
          lastSize = stat.size;
          const chunk = leftover + buf.toString('utf8');
          const parts = chunk.split('\n');
          leftover = parts.pop() || '';
          for (const l of parts) {
            if (l) out.log(formatLogLine(l));
          }
        }
      } catch (e) {
        err.error(`logs follow error: ${e.message}`);
      }
    }, intervalMs);
    const stop = () => {
      clearInterval(handle);
      resolve(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

// ---------------------------------------------------------------------------
// accounts: read/edit the TARGET_ACCOUNTS line in the project's .env file.
// We preserve every other line byte-for-byte so user comments survive.
// ---------------------------------------------------------------------------

function normalizeAccount(name) {
  return String(name || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function parseAccountsLine(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('@') ? s.slice(1) : s))
    .map((s) => s.toLowerCase());
}

function readEnvAccounts(envText) {
  const lines = String(envText || '').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*TARGET_ACCOUNTS\s*=(.*)$/);
    if (m) return parseAccountsLine(m[1]);
  }
  return [];
}

function writeEnvAccounts(envText, accounts) {
  const newValue = `TARGET_ACCOUNTS=${accounts.join(',')}`;
  const lines = String(envText || '').split('\n');
  let replaced = false;
  const out = lines.map((line) => {
    if (!replaced && /^\s*TARGET_ACCOUNTS\s*=/.test(line)) {
      replaced = true;
      return newValue;
    }
    return line;
  });
  if (!replaced) {
    // Append cleanly without leaving a stray blank line.
    if (out.length > 0 && out[out.length - 1] === '') {
      out[out.length - 1] = newValue;
      out.push('');
    } else {
      out.push(newValue);
    }
  }
  return out.join('\n');
}

function accountsList(args) {
  const a = args || {};
  const envFile = a.envFile || '.env';
  const fsDep = a.fs || fs;
  const out = a.out || console;
  if (!fsDep.existsSync(envFile)) {
    return { code: 0, accounts: [] };
  }
  const text = fsDep.readFileSync(envFile, 'utf8');
  const accounts = readEnvAccounts(text);
  if (a.silent !== true) {
    if (accounts.length === 0) out.log('(no target accounts)');
    else for (const u of accounts) out.log(u);
  }
  return { code: 0, accounts };
}

function accountsAdd(args) {
  const a = args || {};
  const envFile = a.envFile || '.env';
  const fsDep = a.fs || fs;
  const out = a.out || console;
  const err = a.err || console;
  const username = normalizeAccount(a.username);
  if (!username) {
    err.error('accounts add: <username> is required');
    return { code: 1 };
  }
  if (!VALID_USERNAME_RE.test(username)) {
    // Reject anything outside X's actual handle alphabet. Without this, a
    // username containing a newline or comma would inject arbitrary key=value
    // lines into .env that dotenv would later read as separate env vars.
    err.error(
      `accounts add: invalid username ${JSON.stringify(a.username)} ` +
        '(X handles are 1-15 chars of [A-Za-z0-9_])'
    );
    return { code: 1 };
  }
  if (!fsDep.existsSync(envFile)) {
    err.error(`accounts add: ${envFile} not found - copy .env.example to .env first`);
    return { code: 1 };
  }
  const text = fsDep.readFileSync(envFile, 'utf8');
  const accounts = readEnvAccounts(text);
  if (accounts.includes(username)) {
    if (a.silent !== true) out.log(`@${username} already present`);
    return { code: 0, accounts };
  }
  const next = [...accounts, username];
  const updated = writeEnvAccounts(text, next);
  fsDep.writeFileSync(envFile, updated);
  if (a.silent !== true) out.log(`added @${username}`);
  return { code: 0, accounts: next };
}

function accountsRemove(args) {
  const a = args || {};
  const envFile = a.envFile || '.env';
  const fsDep = a.fs || fs;
  const out = a.out || console;
  const err = a.err || console;
  const username = normalizeAccount(a.username);
  if (!username) {
    err.error('accounts remove: <username> is required');
    return { code: 1 };
  }
  if (!VALID_USERNAME_RE.test(username)) {
    err.error(
      `accounts remove: invalid username ${JSON.stringify(a.username)} ` +
        '(X handles are 1-15 chars of [A-Za-z0-9_])'
    );
    return { code: 1 };
  }
  if (!fsDep.existsSync(envFile)) {
    err.error(`accounts remove: ${envFile} not found - copy .env.example to .env first`);
    return { code: 1 };
  }
  const text = fsDep.readFileSync(envFile, 'utf8');
  const accounts = readEnvAccounts(text);
  if (!accounts.includes(username)) {
    if (a.silent !== true) out.log(`@${username} not in TARGET_ACCOUNTS`);
    return { code: 0, accounts };
  }
  const next = accounts.filter((u) => u !== username);
  const updated = writeEnvAccounts(text, next);
  fsDep.writeFileSync(envFile, updated);
  if (a.silent !== true) out.log(`removed @${username}`);
  return { code: 0, accounts: next };
}

// ---------------------------------------------------------------------------
// db migrate / db reset
// ---------------------------------------------------------------------------

function dbMigrate(args) {
  const a = args || {};
  const out = a.out || console;
  const dbPath = a.dbPath || path.resolve('./data/bot.db');
  let dbDeps;
  if (a.db) {
    dbDeps = a.db;
  } else {
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    dbDeps = createDb({ path: dbPath });
  }
  try {
    if (a.silent !== true) out.log('migrate: schema is up to date');
    return { code: 0 };
  } finally {
    if (!a.db) {
      try {
        dbDeps.close();
      } catch (_) {
        // ignore
      }
    }
  }
}

function dbReset(args) {
  const a = args || {};
  const out = a.out || console;
  const err = a.err || console;
  const dbPath = a.dbPath || path.resolve('./data/bot.db');
  if (!a.confirm) {
    err.error('db reset: refusing to drop tweets table without --confirm. pass --confirm to proceed.');
    return { code: 1 };
  }
  let dbDeps;
  if (a.db) {
    dbDeps = a.db;
  } else {
    // Real-path branch: nudge the operator before the destructive DROP.
    // SQLite WAL mode lets a live scheduler keep its connection open, so the
    // DROP succeeds but the scheduler's prepared statements start failing on
    // the next cycle. Detection is unreliable across platforms, so we always
    // print the warning when running against a real DB file.
    err.error(
      `db reset: about to DROP and recreate tweets in ${dbPath}. ` +
        'If the scheduler is currently running against this DB, stop it first ' +
        '(Ctrl+C the `node bot.js` / `node cli.js start` process); a live writer ' +
        'will hit insert/update errors after this.'
    );
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    dbDeps = createDb({ path: dbPath });
  }
  try {
    dbDeps.db.exec('DROP TABLE IF EXISTS tweets;');
    // Reuse the schema constant from bot.js so this branch cannot drift from
    // createDb's initial-open schema.
    dbDeps.db.exec(SCHEMA_SQL);
    if (a.silent !== true) out.log('db reset: tweets table recreated');
    return { code: 0 };
  } finally {
    if (!a.db) {
      try {
        dbDeps.close();
      } catch (_) {
        // ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Commander program builder. Tests can build their own program via this
// factory and then call `program.parseAsync([...], {from:'user'})`.
// ---------------------------------------------------------------------------

function buildProgram(opts) {
  const o = opts || {};
  const onExit = typeof o.onExit === 'function' ? o.onExit : (code) => process.exit(code);

  const program = new Command();
  program
    .name('x-scraper')
    .description('X scraper to WhatsApp bot')
    .version(pkg.version);

  program
    .command('start')
    .description('run the scrape -> WAHA scheduler')
    .option('--once', 'run a single cycle then exit')
    .action(async (options) => {
      const config = loadConfig();
      const code = await runStart({
        once: Boolean(options.once),
        config,
      });
      if (code !== 0) onExit(code);
    });

  program
    .command('scrape <username>')
    .description('scrape one X account and print the candidate tweets')
    .option('--limit <n>', 'max tweets to print', (v) => parseInt(v, 10))
    .option('--json', 'output as JSON', false)
    .option('--dry-run', 'parse args, do not launch puppeteer', false)
    .action(async (username, options) => {
      const code = await runScrape({ username, options });
      if (code !== 0) onExit(code);
    });

  program
    .command('send <text>')
    .description('send a one-off text message to the configured WAHA channel')
    .option('--channel <id>', 'override WAHA_CHANNEL_ID')
    .action(async (text, options) => {
      const code = await runSend({ text, options });
      if (code !== 0) onExit(code);
    });

  program
    .command('health')
    .description('check the WAHA session state; exit 0 only when CONNECTED')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      const code = await runHealth({ json: Boolean(options.json) });
      if (code !== 0) onExit(code);
    });

  program
    .command('stats')
    .description('print SQLite tweet counts and the 5 most recent rows')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      const code = await runStats({ json: Boolean(options.json) });
      if (code !== 0) onExit(code);
    });

  program
    .command('logs')
    .description('tail ./logs/bot.log; -f follows like tail -f')
    .option('-n, --lines <n>', 'number of lines to show', (v) => parseInt(v, 10), 50)
    .option('-f, --follow', 'follow the log file', false)
    .action(async (options) => {
      const code = await runLogs({
        lines: options.lines,
        follow: Boolean(options.follow),
      });
      if (code !== 0) onExit(code);
    });

  const accounts = program
    .command('accounts')
    .description('manage TARGET_ACCOUNTS in your .env file');
  accounts
    .command('list')
    .description('print the current TARGET_ACCOUNTS list')
    .action(() => {
      const r = accountsList({});
      if (r.code !== 0) onExit(r.code);
    });
  accounts
    .command('add <username>')
    .description('append a username to TARGET_ACCOUNTS (deduped)')
    .action((username) => {
      const r = accountsAdd({ username });
      if (r.code !== 0) onExit(r.code);
    });
  accounts
    .command('remove <username>')
    .description('drop a username from TARGET_ACCOUNTS (case-insensitive)')
    .action((username) => {
      const r = accountsRemove({ username });
      if (r.code !== 0) onExit(r.code);
    });

  const db = program.command('db').description('manage the SQLite tweet store');
  db.command('migrate')
    .description('ensure the tweets table exists (idempotent)')
    .action(() => {
      const r = dbMigrate({});
      if (r.code !== 0) onExit(r.code);
    });
  db.command('reset')
    .description('drop and recreate the tweets table; requires --confirm')
    .option('--confirm', 'really drop and recreate the tweets table', false)
    .action((options) => {
      const r = dbReset({ confirm: Boolean(options.confirm) });
      if (r.code !== 0) onExit(r.code);
    });

  return program;
}

module.exports = {
  // Subcommand handlers (for tests):
  runStart,
  runStartValidate,
  runScrape,
  runSend,
  runHealth,
  runStats,
  runLogs,
  accountsList,
  accountsAdd,
  accountsRemove,
  dbMigrate,
  dbReset,
  // Helpers:
  buildProgram,
  formatLogLine,
  normalizeAccount,
  parseAccountsLine,
  readEnvAccounts,
  writeEnvAccounts,
  VALID_USERNAME_RE,
};

// ---------------------------------------------------------------------------
// Script entry: only when invoked directly.
// ---------------------------------------------------------------------------

if (require.main === module) {
  const program = buildProgram();
  program.parseAsync(process.argv).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`cli error: ${err.message}`);
    process.exit(1);
  });
}
