/**
 * X/Twitter Scraper to WhatsApp Channel Bot
 *
 * Scrapes target X accounts via Puppeteer, dedups tweet IDs in SQLite,
 * and reposts new tweets to a WhatsApp channel via the WAHA HTTP API.
 *
 * Run as a script:   node bot.js
 * Or require:        const { CONFIG, scrapeAccount, ... } = require('./bot.js')
 *
 * Requiring this module has zero side effects: no fs.mkdirSync, no SQLite
 * open, no puppeteer launch. The scheduler IIFE only runs when invoked
 * directly via `node bot.js`.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');
const puppeteer = require('puppeteer');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function parseIntClamped(value, fallback, min) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed < min ? min : parsed;
}

function loadConfig(env) {
  const e = env || process.env;
  return {
    wahaUrl: e.WAHA_URL || 'http://localhost:3000',
    wahaSession: e.WAHA_SESSION || 'default',
    wahaChannelId: e.WAHA_CHANNEL_ID || '',
    targetAccounts: (e.TARGET_ACCOUNTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith('@') ? s.slice(1) : s)),
    filterKeywords: (e.FILTER_KEYWORDS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    skipReplies: parseBool(e.SKIP_REPLIES, true),
    skipRetweets: parseBool(e.SKIP_RETWEETS, true),
    checkIntervalMinutes: parseIntClamped(e.CHECK_INTERVAL_MINUTES, 5, 1),
    messageDelayMs: parseIntClamped(e.MESSAGE_DELAY_MS, 5000, 1000),
    maxTweetsPerCheck: parseIntClamped(e.MAX_TWEETS_PER_CHECK, 5, 1),
    headless: parseBool(e.HEADLESS, true),
    puppeteerExecutablePath: e.PUPPETEER_EXECUTABLE_PATH || undefined,
  };
}

const CONFIG = loadConfig();

// ---------------------------------------------------------------------------
// Logger - JSON-line records to ./logs/bot.log + human-readable console
// ---------------------------------------------------------------------------

const LOG_DIR = path.resolve('./logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');

function createLogger(options) {
  const opts = options || {};
  const logFile = opts.logFile || null;
  const out = opts.console || console;

  function writeLog(level, message, extra) {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(extra && typeof extra === 'object' ? extra : {}),
    };
    if (logFile) {
      try {
        fs.appendFileSync(logFile, JSON.stringify(record) + '\n');
      } catch (err) {
        // If we cannot write the log file, fall through to console only.
        // eslint-disable-next-line no-console
        out.error('Failed to write log file:', err.message);
      }
    }
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
    const human = `[${record.timestamp}] ${prefix} ${level.toUpperCase()}: ${message}`;
    if (level === 'error') {
      out.error(human);
    } else if (level === 'warn') {
      out.warn(human);
    } else {
      out.log(human);
    }
  }

  return {
    info: (msg, extra) => writeLog('info', msg, extra),
    warn: (msg, extra) => writeLog('warn', msg, extra),
    error: (msg, extra) => writeLog('error', msg, extra),
  };
}

let loggerSingleton = null;
function getLogger() {
  if (!loggerSingleton) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    loggerSingleton = createLogger({ logFile: LOG_FILE });
  }
  return loggerSingleton;
}

// ---------------------------------------------------------------------------
// SQLite - tweet dedup store
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve('./data');
const DB_PATH = path.join(DATA_DIR, 'bot.db');

function createDb(options) {
  const opts = options || {};
  const dbPath = opts.path || ':memory:';
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tweets (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      content TEXT,
      tweet_url TEXT,
      posted_to_whatsapp INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tweets_username_created
      ON tweets (username, created_at);
  `);

  const stmtInsertTweet = db.prepare(
    'INSERT OR IGNORE INTO tweets (id, username, content, tweet_url, posted_to_whatsapp) VALUES (?, ?, ?, ?, 0)'
  );
  const stmtFindTweet = db.prepare(
    'SELECT id FROM tweets WHERE id = ? AND posted_to_whatsapp = 1'
  );
  const stmtMarkPosted = db.prepare(
    'UPDATE tweets SET posted_to_whatsapp = 1 WHERE id = ?'
  );

  return {
    db,
    stmtInsertTweet,
    stmtFindTweet,
    stmtMarkPosted,
    close: () => db.close(),
  };
}

let dbHandle = null;
function getDb() {
  if (!dbHandle) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    dbHandle = createDb({ path: DB_PATH });
  }
  return dbHandle;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extract the stable tweet id (the trailing /status/<id> segment) from a
 * tweet URL. Falls back to the full URL if the pattern is not matched.
 */
function tweetIdFromHref(href) {
  if (!href) return null;
  const match = String(href).match(/\/status\/(\d+)/);
  return match ? match[1] : href;
}

/**
 * Extract the username from a tweet URL path: https://x.com/<user>/status/<id>
 */
function usernameFromHref(href) {
  if (!href) return null;
  try {
    const url = new URL(href);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[0] ? parts[0].toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scraper
// ---------------------------------------------------------------------------

async function scrapeAccount(browser, username, options) {
  const opts = options || {};
  const config = opts.config || CONFIG;
  const log = opts.log || getLogger();

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    log.info(`Scraping @${username}`);
    await page.goto(`https://twitter.com/${username}`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await sleep(3000);

    // Best-effort: dismiss the login popup if it appears.
    try {
      const closeBtn = await page.$('[data-testid="app-bar-close"]');
      if (closeBtn) {
        await closeBtn.click();
        await sleep(1000);
      }
    } catch (_) {
      // ignore
    }

    // Wait for tweets to render. If none appear, log and bail.
    try {
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 });
    } catch (_) {
      log.warn(`No tweets found for @${username} (selector timeout)`);
      return [];
    }

    const limit = config.maxTweetsPerCheck * 3;
    const tweets = await page.evaluate((maxItems) => {
      const out = [];
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      articles.forEach((el, idx) => {
        if (idx >= maxItems) return;

        const textEl = el.querySelector('[data-testid="tweetText"]');
        const timeEl = el.querySelector('time');
        const linkEl = timeEl ? timeEl.closest('a') : null;

        // Detect retweet via socialContext label.
        let isRetweet = false;
        const social = el.querySelector('[data-testid="socialContext"]');
        if (social && social.textContent) {
          const txt = social.textContent.toLowerCase();
          if (txt.includes('retweeted') || txt.includes('reposted')) {
            isRetweet = true;
          }
        }

        // Detect reply via "Replying to" indicator.
        let isReply = false;
        const candidates = el.querySelectorAll('div, span');
        for (const c of candidates) {
          const t = (c.textContent || '').trim();
          if (t.startsWith('Replying to')) {
            isReply = true;
            break;
          }
        }

        out.push({
          text: textEl ? textEl.textContent || '' : '',
          time: timeEl ? timeEl.getAttribute('datetime') : null,
          href: linkEl ? linkEl.href : null,
          isRetweet,
          isReply,
        });
      });
      return out;
    }, limit);

    log.info(`Scraped ${tweets.length} candidate tweet(s) for @${username}`);
    return tweets;
  } finally {
    try {
      await page.close();
    } catch (_) {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

function filterTweets(tweets, username, options) {
  const opts = options || {};
  const config = opts.config || CONFIG;
  const dbDeps = opts.db || getDb();
  const stmtFindTweet = dbDeps.stmtFindTweet;

  const expected = String(username || '').toLowerCase();
  const keywords = config.filterKeywords;

  const kept = [];
  for (const t of tweets) {
    if (!t || !t.href || !t.text) continue;
    if (config.skipReplies && t.isReply) continue;
    if (config.skipRetweets && t.isRetweet) continue;

    // Defend against pinned/quoted reposts where the path username
    // doesn't match the requested account.
    if (config.skipRetweets) {
      const pathUser = usernameFromHref(t.href);
      if (pathUser && pathUser !== expected) continue;
    }

    if (keywords.length > 0) {
      const lower = t.text.toLowerCase();
      const matches = keywords.some((k) => lower.includes(k));
      if (!matches) continue;
    }

    const id = tweetIdFromHref(t.href);
    if (!id) continue;
    if (stmtFindTweet.get(id)) continue; // already posted

    kept.push({
      id,
      username: expected,
      content: t.text,
      tweet_url: t.href,
      time: t.time,
    });
  }

  // Sort oldest-first (chronological order when posting).
  kept.sort((a, b) => {
    const ta = a.time ? Date.parse(a.time) : 0;
    const tb = b.time ? Date.parse(b.time) : 0;
    return ta - tb;
  });

  return kept.slice(0, config.maxTweetsPerCheck);
}

// ---------------------------------------------------------------------------
// WhatsApp send via WAHA
// ---------------------------------------------------------------------------

function formatMessage(tweet) {
  return `🐦 @${tweet.username}\n\n${tweet.content}\n\n🔗 ${tweet.tweet_url}`;
}

async function postToWhatsApp(tweet, options) {
  const opts = options || {};
  const config = opts.config || CONFIG;
  const dbDeps = opts.db || getDb();
  const http = opts.http || axios;
  const log = opts.log || getLogger();
  const { stmtInsertTweet, stmtMarkPosted } = dbDeps;

  // Insert the row with posted=0 BEFORE sending so a crash mid-post
  // doesn't lose the dedup record. We flip the flag only on success.
  stmtInsertTweet.run(tweet.id, tweet.username, tweet.content, tweet.tweet_url);

  const text = formatMessage(tweet);
  try {
    const response = await http.post(
      `${config.wahaUrl}/api/sendText`,
      {
        session: config.wahaSession,
        chatId: config.wahaChannelId,
        text,
        linkPreview: false,
      },
      { timeout: 30000 }
    );

    if (response.status >= 200 && response.status < 300) {
      stmtMarkPosted.run(tweet.id);
      log.info(`Posted tweet ${tweet.id} from @${tweet.username}`);
      return true;
    }

    log.error('WAHA returned non-2xx', {
      tweetId: tweet.id,
      status: response.status,
      body: response.data,
    });
    return false;
  } catch (err) {
    const status = err.response ? err.response.status : null;
    const body = err.response ? err.response.data : null;
    log.error(`Failed to post tweet ${tweet.id}: ${err.message}`, {
      tweetId: tweet.id,
      status,
      body,
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

async function runCycle(browser, options) {
  const opts = options || {};
  const config = opts.config || CONFIG;
  const log = opts.log || getLogger();

  log.info(`Starting cycle for ${config.targetAccounts.length} account(s)`);

  for (const username of config.targetAccounts) {
    let scraped = 0;
    let fresh = 0;
    let posted = 0;
    let errors = 0;

    try {
      const tweets = await scrapeAccount(browser, username, { config, log });
      scraped = tweets.length;

      const newTweets = filterTweets(tweets, username, opts);
      fresh = newTweets.length;

      for (const tweet of newTweets) {
        const ok = await postToWhatsApp(tweet, opts);
        if (ok) {
          posted += 1;
        } else {
          errors += 1;
        }
        await sleep(config.messageDelayMs);
      }
    } catch (err) {
      errors += 1;
      log.error(`Account @${username} failed: ${err.message}`, {
        username,
        stack: err.stack,
      });
    }

    log.info(
      `@${username} summary scraped=${scraped} new=${fresh} posted=${posted} errors=${errors}`,
      { username, scraped, new: fresh, posted, errors }
    );
  }

  log.info('Cycle complete');
}

// ---------------------------------------------------------------------------
// Module exports - safe to require without launching anything
// ---------------------------------------------------------------------------

module.exports = {
  CONFIG,
  scrapeAccount,
  filterTweets,
  postToWhatsApp,
  runCycle,
  // Factories and helpers exposed for tests and the CLI:
  loadConfig,
  createLogger,
  createDb,
  parseBool,
  parseIntClamped,
  tweetIdFromHref,
  usernameFromHref,
  formatMessage,
};

// ---------------------------------------------------------------------------
// Scheduler - only runs when invoked directly
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Validate required env vars only when running as a script.
  const missing = [];
  if (CONFIG.targetAccounts.length === 0) missing.push('TARGET_ACCOUNTS');
  if (!CONFIG.wahaChannelId) missing.push('WAHA_CHANNEL_ID');
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `❌ Missing required environment variable(s): ${missing.join(', ')}.\n` +
        `   Copy .env.example to .env and fill in the values.`
    );
    process.exit(1);
  }

  const log = getLogger();
  const dbDeps = getDb();

  let browser = null;
  let intervalHandle = null;
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    try {
      if (browser) await browser.close();
    } catch (err) {
      log.error(`Error closing browser: ${err.message}`);
    }
    try {
      dbDeps.close();
    } catch (err) {
      log.error(`Error closing database: ${err.message}`);
    }
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled rejection: ${reason && reason.message ? reason.message : reason}`, {
      reason: reason && reason.stack ? reason.stack : String(reason),
    });
  });

  (async () => {
    log.info('Starting X scraper bot', {
      targetAccounts: CONFIG.targetAccounts,
      checkIntervalMinutes: CONFIG.checkIntervalMinutes,
      headless: CONFIG.headless,
    });

    const launchOptions = {
      headless: CONFIG.headless ? 'new' : false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    };
    if (CONFIG.puppeteerExecutablePath) {
      launchOptions.executablePath = CONFIG.puppeteerExecutablePath;
    }

    try {
      browser = await puppeteer.launch(launchOptions);
    } catch (err) {
      log.error(`Failed to launch puppeteer: ${err.message}`);
      process.exit(1);
    }

    // Run once immediately.
    try {
      await runCycle(browser);
    } catch (err) {
      log.error(`Initial cycle failed: ${err.message}`, { stack: err.stack });
    }

    intervalHandle = setInterval(() => {
      runCycle(browser).catch((err) =>
        log.error(`Cycle failed: ${err.message}`, { stack: err.stack })
      );
    }, CONFIG.checkIntervalMinutes * 60 * 1000);
  })();
}
