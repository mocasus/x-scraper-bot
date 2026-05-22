/**
 * Blessed/blessed-contrib UI shell for the x-scraper-bot TUI dashboard.
 *
 * The pure data + render + log-tail layer lives in ./data, ./render, and
 * ./log-tail. This file only wires those modules into terminal widgets,
 * keybindings, intervals, and a graceful cleanup path.
 *
 * Requiring this module has no side effects: blessed is loaded lazily
 * inside runDashboard's screenFactory so importing dashboard/index.js
 * from a non-TTY context (a test, `cli.js --help`, etc.) does not open
 * /dev/tty or allocate a screen.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const child_process = require('node:child_process');
const axios = require('axios');

const bot = require('../bot.js');
const dataModule = require('./data');
const logTailModule = require('./log-tail');
const render = require('./render');

// Default screenFactory: lazily require blessed only when actually needed.
// Tests inject their own factory and never reach this branch.
function defaultScreenFactory() {
  // eslint-disable-next-line global-require
  const blessed = require('blessed');
  return blessed.screen({
    smartCSR: true,
    fullUnicode: false,
    title: 'x-scraper-bot dashboard',
  });
}

// Default widget builder: build the contrib.grid layout described in the
// task plan. Returns null when the caller passed opts.skipUi (tests).
function defaultBuildUi(screen) {
  // eslint-disable-next-line global-require
  const blessed = require('blessed');
  // eslint-disable-next-line global-require
  const contrib = require('blessed-contrib');

  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  const statusBox = grid.set(0, 0, 3, 4, blessed.box, {
    label: ' Status ',
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' } },
  });

  const statsBox = grid.set(0, 4, 3, 3, blessed.box, {
    label: ' Today ',
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' } },
  });

  const histChart = grid.set(0, 7, 3, 5, contrib.line, {
    label: ' Tweets/hr (last 24h) ',
    showLegend: false,
    style: { line: 'yellow', text: 'white', baseline: 'gray' },
    xLabelPadding: 1,
    xPadding: 1,
    wholeNumbersOnly: true,
  });

  const accountsTable = grid.set(3, 0, 4, 5, contrib.table, {
    label: ' Accounts (last seen) ',
    keys: false,
    interactive: false,
    fg: 'white',
    columnSpacing: 2,
    columnWidth: [16, 10],
    border: { type: 'line' },
  });

  const recentTable = grid.set(3, 5, 4, 7, contrib.table, {
    label: ' Recent tweets ',
    keys: false,
    interactive: false,
    fg: 'white',
    columnSpacing: 1,
    columnWidth: [2, 14, 60],
    border: { type: 'line' },
  });

  const logBox = grid.set(7, 0, 4, 12, contrib.log, {
    label: ' Logs (live) ',
    tags: true,
    bufferLength: 200,
    border: { type: 'line' },
  });

  const helpBar = grid.set(11, 0, 1, 12, blessed.box, {
    tags: true,
    style: { fg: 'white', bg: 'blue' },
    content:
      ' {bold}?{/bold}:help  {bold}q{/bold}:quit  {bold}r{/bold}:refresh  ' +
      '{bold}s{/bold}:scrape  {bold}a{/bold}:accounts  {bold}c{/bold}:clear',
  });

  return { statusBox, statsBox, histChart, accountsTable, recentTable, logBox, helpBar, grid };
}

// ---------------------------------------------------------------------------
// formatLogRecord: helpers for one tail line. Exported for testability.
// ---------------------------------------------------------------------------

function formatLogRecord(line) {
  try {
    const rec = JSON.parse(line);
    const time =
      rec.timestamp && rec.timestamp.indexOf('T') >= 0
        ? rec.timestamp.split('T')[1].split('.')[0]
        : rec.timestamp || '';
    const lvl = String(rec.level || 'info').toUpperCase();
    const color = render.colorForLevel(rec.level);
    return `{${color}}[${time}] [${lvl}]: ${rec.message || ''}{/${color}}`;
  } catch (_e) {
    return line;
  }
}

function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ---------------------------------------------------------------------------
// runDashboard
// ---------------------------------------------------------------------------

/**
 * Boot the TUI dashboard.
 *
 * opts (all optional):
 *   stdout, stderr        - process I/O streams. Default: process.stdout/stderr.
 *   config                - bot config (loaded). Default: bot.CONFIG.
 *   dbPath, logFile       - on-disk paths. Defaults: ./data/bot.db, ./logs/bot.log.
 *   refreshSeconds        - panel refresh cadence. Default: 15.
 *   http                  - axios-shaped { get(url, opts) }. Default: axios.
 *   now                   - () => Date. Default: real clock.
 *   db                    - injected createDb() result; if set, runDashboard
 *                           will not open the on-disk DB or close it on exit.
 *   screenFactory         - () => blessed.screen-shaped object. Default uses blessed.
 *   buildUi               - (screen) => widgets bundle. Default builds the
 *                           full blessed-contrib grid. Pass null/false to
 *                           skip widget construction (used by tests).
 *   skipUi                - alias: skip widget construction.
 *   skipExit              - if true, never call process.exit on shutdown.
 *   returnHandle          - if true, resolve immediately with { cleanup }
 *                           instead of awaiting shutdown.
 *   cwd                   - working dir for the spawn-scrape child. Default: process.cwd().
 *
 * Returns:
 *   1                      when stdout is not a TTY.
 *   { cleanup, shutdown }  when opts.returnHandle (or skipExit) is set.
 *   Promise<0>             otherwise; resolves only on shutdown.
 */
async function runDashboard(opts) {
  const o = opts || {};
  const stdout = o.stdout || process.stdout;
  const stderr = o.stderr || process.stderr;

  // (1) TTY guard - the dashboard cannot render into a pipe.
  if (!stdout.isTTY) {
    stderr.write(
      'dashboard requires a TTY (run from an interactive terminal; not pipeable)\n'
    );
    return 1;
  }

  const config = o.config || bot.CONFIG;
  const dbPath = o.dbPath || path.resolve('./data/bot.db');
  const logFile = o.logFile || path.resolve('./logs/bot.log');
  const refreshSeconds = Number.isFinite(Number(o.refreshSeconds))
    ? Math.max(1, Number(o.refreshSeconds))
    : 15;
  const http = o.http || axios;
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const cwd = o.cwd || process.cwd();
  const skipExit = Boolean(o.skipExit || o.returnHandle);
  const skipUi = Boolean(o.skipUi || o.buildUi === false || o.buildUi === null);

  // (2) Open the DB unless one was injected.
  let dbDeps;
  let ownDb = false;
  if (o.db) {
    dbDeps = o.db;
  } else {
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_e) { /* ignore */ }
    }
    dbDeps = bot.createDb({ path: dbPath });
    ownDb = true;
  }

  // (3) Ensure ./logs exists so log-tail can attach even if the file
  //     is created later by a separate bot.js process.
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch (_e) {
    // ignore - dashboard still runs even if the dir is missing
  }

  const startedAt = now();
  const dataDeps = { db: dbDeps, http, config, now, startedAt };

  // (4) Construct screen + widgets.
  const screenFactory = typeof o.screenFactory === 'function'
    ? o.screenFactory
    : defaultScreenFactory;
  const screen = screenFactory();

  let widgets = null;
  if (!skipUi) {
    const builder = typeof o.buildUi === 'function' ? o.buildUi : defaultBuildUi;
    widgets = builder(screen, { config });
  }

  // (5) Ring buffer for the log box - the 'c' keybind clears the on-screen
  //     view without truncating the source file.
  const ringBuffer = [];
  function pushLog(line) {
    ringBuffer.push(line);
    if (ringBuffer.length > 200) ringBuffer.shift();
    if (widgets && widgets.logBox && typeof widgets.logBox.log === 'function') {
      try { widgets.logBox.log(line); } catch (_e) { /* ignore */ }
    }
  }

  function safeRender() {
    try { screen.render(); } catch (_e) { /* ignore */ }
  }

  // (6) refreshAll - one async pass over every data getter.
  async function refreshAll() {
    let status;
    try {
      status = await dataModule.getStatus(dataDeps);
    } catch (e) {
      pushLog(`{red-fg}refresh: status error ${e.message}{/red-fg}`);
      status = { waha: { state: 'UNREACHABLE', color: 'red' }, uptimeSeconds: 0 };
    }
    let today;
    let hist;
    let accounts;
    let recent;
    try {
      today = dataModule.getTodayStats(dataDeps);
      hist = dataModule.getHourlyHistogram(dataDeps);
      accounts = dataModule.getAccountsWithLastSeen(dataDeps);
      recent = dataModule.getRecentTweets(dataDeps, 10);
    } catch (e) {
      pushLog(`{red-fg}refresh: db error ${e.message}{/red-fg}`);
      return;
    }

    if (!widgets) return;

    const wahaColor = status.waha.color || 'gray';
    const wahaState = status.waha.state || 'UNKNOWN';
    const uptime = formatUptime(status.uptimeSeconds);
    const accountsConfigured = (config.targetAccounts || []).length;

    widgets.statusBox.setContent(
      ` {bold}WAHA{/bold}    {${wahaColor}-fg}${wahaState}{/${wahaColor}-fg}\n` +
      ` Accounts {bold}${accountsConfigured}{/bold}\n` +
      ` Uptime  ${uptime}`
    );
    widgets.statsBox.setContent(
      ` Scraped {bold}${today.scraped}{/bold}\n` +
      ` Posted  {bold}${today.posted}{/bold}\n` +
      ` Pending {bold}${today.errors}{/bold}`
    );

    try {
      widgets.histChart.setData([
        { title: 'tweets', x: hist.hours, y: hist.counts, style: { line: 'yellow' } },
      ]);
    } catch (_e) { /* ignore chart sizing errors on tiny terminals */ }

    try {
      const nowDate = now();
      widgets.accountsTable.setData({
        headers: ['username', 'last seen'],
        data: accounts.map((a) => [
          `@${a.username}`,
          render.formatRelativeTime(a.lastSeen, nowDate),
        ]),
      });
    } catch (_e) { /* ignore */ }

    try {
      const nowDate = now();
      widgets.recentTable.setData({
        headers: ['', 'when', 'tweet'],
        data: recent.map((t) => [
          t.posted_to_whatsapp ? 'OK' : '--',
          `@${t.username} ${render.formatRelativeTime(t.created_at, nowDate)}`,
          render.truncate(String(t.content || '').replace(/\s+/g, ' '), 60),
        ]),
      });
    } catch (_e) { /* ignore */ }

    safeRender();
  }

  // (7) Run an initial refresh; then schedule the slow + fast intervals.
  await refreshAll();

  const refreshHandle = setInterval(() => {
    refreshAll();
  }, refreshSeconds * 1000);
  // Bump uptime cell every second without re-running every getter.
  const uptimeHandle = setInterval(() => {
    if (!widgets) return;
    const wahaState = (widgets._lastWahaState && widgets._lastWahaState) || '';
    void wahaState;
    const uptime = formatUptime(
      Math.floor((now().getTime() - startedAt.getTime()) / 1000)
    );
    try {
      // Replace the last line of the status box content with the live uptime.
      const current = widgets.statusBox.getContent ? widgets.statusBox.getContent() : '';
      const lines = String(current).split('\n');
      const idx = lines.findIndex((l) => /Uptime/.test(l));
      if (idx >= 0) {
        lines[idx] = ` Uptime  ${uptime}`;
        widgets.statusBox.setContent(lines.join('\n'));
        safeRender();
      }
    } catch (_e) { /* ignore */ }
  }, 1000);

  // (8) Log tailer.
  const tailHandle = logTailModule.tailLog(logFile, (line) => {
    pushLog(formatLogRecord(line));
    safeRender();
  });

  // (9) Cleanup - idempotent, safe to call from any code path.
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try { clearInterval(refreshHandle); } catch (_e) { /* ignore */ }
    try { clearInterval(uptimeHandle); } catch (_e) { /* ignore */ }
    try { tailHandle.stop(); } catch (_e) { /* ignore */ }
    if (ownDb) {
      try { dbDeps.close(); } catch (_e) { /* ignore */ }
    }
    try { screen.destroy(); } catch (_e) { /* ignore */ }
  }

  // (10) Resolution: returnHandle short-circuits, otherwise the function
  //      stays pending until 'q' / Ctrl+C / SIGINT triggers shutdown.
  let shutdownResolve;
  const shutdownPromise = new Promise((resolve) => { shutdownResolve = resolve; });

  function gracefulShutdown(code) {
    cleanup();
    if (typeof shutdownResolve === 'function') {
      shutdownResolve(code || 0);
      shutdownResolve = null;
    }
    if (!skipExit) {
      // eslint-disable-next-line no-process-exit
      process.exit(code || 0);
    }
  }

  // (11) Keybindings. The stub screens used by tests provide a no-op
  //      key()/on() so these calls are harmless there.
  function spawnScrape() {
    const targets = (config.targetAccounts || []);
    const username = targets[0];
    if (!username) {
      pushLog('{yellow-fg}[scrape] no TARGET_ACCOUNTS configured{/yellow-fg}');
      safeRender();
      return;
    }
    pushLog(`{cyan-fg}[scrape] starting node cli.js scrape ${username} --json --limit 5{/cyan-fg}`);
    safeRender();
    let child;
    try {
      child = child_process.spawn(
        process.execPath,
        ['cli.js', 'scrape', username, '--json', '--limit', '5'],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (e) {
      pushLog(`{red-fg}[scrape] spawn failed: ${e.message}{/red-fg}`);
      safeRender();
      return;
    }
    function pipeLines(stream, prefix) {
      let leftover = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        leftover += chunk;
        const parts = leftover.split('\n');
        leftover = parts.pop();
        for (const l of parts) {
          if (l) pushLog(`${prefix} ${l}`);
        }
        safeRender();
      });
      stream.on('end', () => {
        if (leftover) pushLog(`${prefix} ${leftover}`);
        safeRender();
      });
    }
    pipeLines(child.stdout, '[scrape]');
    pipeLines(child.stderr, '{yellow-fg}[scrape:err]{/yellow-fg}');
    child.on('close', (code) => {
      pushLog(`[scrape] exited code=${code}`);
      safeRender();
    });
  }

  function clearLogs() {
    ringBuffer.length = 0;
    if (widgets && widgets.logBox) {
      try {
        if (typeof widgets.logBox.logLines !== 'undefined') widgets.logBox.logLines = [];
        if (typeof widgets.logBox.setItems === 'function') widgets.logBox.setItems([]);
        if (typeof widgets.logBox.setContent === 'function') widgets.logBox.setContent('');
      } catch (_e) { /* ignore */ }
    }
    safeRender();
  }

  function showHelp() {
    if (!widgets) return;
    // eslint-disable-next-line global-require
    const blessed = require('blessed');
    try {
      const help = blessed.message({
        parent: screen,
        border: 'line',
        height: 'shrink',
        width: 'half',
        top: 'center',
        left: 'center',
        label: ' Help ',
        tags: true,
        keys: true,
        hidden: true,
        vi: true,
      });
      help.display(
        '{bold}Keybindings{/bold}\n\n' +
          '  q, Ctrl+C   quit\n' +
          '  r           refresh now\n' +
          '  s           spawn scrape for first TARGET_ACCOUNT\n' +
          '  a           add/remove an account\n' +
          '  c           clear log panel (file is untouched)\n' +
          '  ?, h        this help\n' +
          '  arrows      scroll log panel',
        0,
        () => {}
      );
      safeRender();
    } catch (e) {
      pushLog(`{red-fg}help: ${e.message}{/red-fg}`);
    }
  }

  function promptAccount() {
    if (!widgets) return;
    // eslint-disable-next-line global-require
    const blessed = require('blessed');
    // Lazy-require cli.js for accountsAdd/accountsRemove to avoid a require
    // cycle (cli.js does not require ./dashboard at module load time).
    // eslint-disable-next-line global-require
    const cli = require('../cli.js');
    try {
      const action = blessed.prompt({
        parent: screen,
        border: 'line',
        height: 'shrink',
        width: 'half',
        top: 'center',
        left: 'center',
        label: ' accounts ',
        tags: true,
        keys: true,
        vi: true,
      });
      action.input('add or remove?', '', (errA, value) => {
        if (errA || !value) { safeRender(); return; }
        const verb = String(value).trim().toLowerCase();
        const handler = verb.startsWith('r') ? cli.accountsRemove : cli.accountsAdd;
        const usernamePrompt = blessed.prompt({
          parent: screen,
          border: 'line',
          height: 'shrink',
          width: 'half',
          top: 'center',
          left: 'center',
          label: ' username ',
          tags: true,
          keys: true,
          vi: true,
        });
        usernamePrompt.input('username (without @)', '', (errU, uname) => {
          if (errU || !uname) { safeRender(); return; }
          const r = handler({ username: String(uname).trim(), silent: true });
          pushLog(
            `{cyan-fg}[accounts] ${verb.startsWith('r') ? 'remove' : 'add'} ${uname} -> code=${r.code}{/cyan-fg}`
          );
          // Refresh the accounts panel - lastSeen may have shifted.
          refreshAll();
        });
      });
      safeRender();
    } catch (e) {
      pushLog(`{red-fg}accounts prompt: ${e.message}{/red-fg}`);
    }
  }

  if (typeof screen.key === 'function') {
    screen.key(['q', 'C-c'], () => gracefulShutdown(0));
    screen.key(['r'], () => { refreshAll(); });
    screen.key(['s'], () => { spawnScrape(); });
    screen.key(['a'], () => { promptAccount(); });
    screen.key(['c'], () => { clearLogs(); });
    screen.key(['?', 'h'], () => { showHelp(); });
  }

  if (typeof screen.on === 'function') {
    screen.on('resize', () => { safeRender(); });
  }

  // (12) Wire SIGINT/SIGTERM. We use process.once so re-entrant runs
  //      (tests, repeated subcommand invocations in the same process)
  //      do not stack handlers indefinitely.
  const sigintHandler = () => gracefulShutdown(0);
  const sigtermHandler = () => gracefulShutdown(0);
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  if (o.returnHandle) {
    return { cleanup, shutdown: gracefulShutdown };
  }

  return shutdownPromise;
}

module.exports = {
  runDashboard,
  formatLogRecord,
  formatUptime,
};
