'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runDashboard } = require('../dashboard');
const { inMemoryDb, freshConfig } = require('./helpers/factories.js');

// ---------------------------------------------------------------------------
// (1) The !isTTY guard short-circuits before any DB / screen / log-tail
//     side effects fire. The smoke test
//
//        echo '' | timeout 2 node cli.js dashboard
//
//     hits this branch.
// ---------------------------------------------------------------------------

test('runDashboard returns 1 and writes a TTY message when stdout is not a TTY', async () => {
  const chunks = [];
  const code = await runDashboard({
    stdout: { isTTY: false },
    stderr: { write: (s) => { chunks.push(String(s)); return true; } },
  });
  assert.equal(code, 1);
  const text = chunks.join('');
  assert.match(text, /requires a TTY/);
  assert.match(text, /\n$/, 'guard message is newline-terminated');
});

test('runDashboard with stdout=undefined does not throw and short-circuits', async () => {
  // process.stdout in a piped harness has isTTY=false; we mimic that here
  // without actually overriding the global.
  const chunks = [];
  const code = await runDashboard({
    stdout: { isTTY: undefined },
    stderr: { write: (s) => { chunks.push(String(s)); return true; } },
  });
  assert.equal(code, 1);
  assert.match(chunks.join(''), /requires a TTY/);
});

// ---------------------------------------------------------------------------
// (2) Past the TTY guard: drive the construction path with stub screen +
//     in-memory DB + fake http. Skips widget construction so we don't need
//     to stub blessed's full Element API. Verifies cleanup() is callable
//     and idempotent and that the function returns the documented handle.
// ---------------------------------------------------------------------------

test('runDashboard returnHandle path constructs the screen and returns a usable cleanup', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-tty-'));
  const logFile = path.join(tmpDir, 'bot.log');
  fs.writeFileSync(logFile, '', 'utf8');

  let screenFactoryCalls = 0;
  let destroyed = 0;
  const stubScreen = {
    key: () => {},
    on: () => {},
    render: () => {},
    destroy: () => { destroyed += 1; },
  };

  const db = inMemoryDb();
  const config = freshConfig({ TARGET_ACCOUNTS: 'alice,bob' });
  const httpCalls = [];
  const http = {
    get: async (url, opts) => {
      httpCalls.push({ url, opts });
      return { status: 200, data: { state: 'CONNECTED' } };
    },
  };

  let handle;
  try {
    handle = await runDashboard({
      stdout: { isTTY: true },
      stderr: { write: () => true },
      config,
      http,
      db,
      logFile,
      refreshSeconds: 60,        // big number so the interval never fires mid-test
      returnHandle: true,         // resolve immediately with { cleanup }
      skipUi: true,               // bypass blessed widget construction
      screenFactory: () => {
        screenFactoryCalls += 1;
        return stubScreen;
      },
    });

    assert.ok(handle, 'returnHandle path should yield a handle object');
    assert.equal(typeof handle.cleanup, 'function', 'handle.cleanup is a function');
    assert.equal(screenFactoryCalls, 1, 'screenFactory invoked exactly once');
    assert.equal(httpCalls.length, 1, 'getStatus.http.get was called once on initial refresh');
    assert.match(httpCalls[0].url, /\/api\/sessions\//);

    // cleanup must not throw and must call screen.destroy() exactly once.
    assert.doesNotThrow(() => handle.cleanup());
    assert.equal(destroyed, 1, 'screen.destroy() ran once on cleanup');

    // cleanup is idempotent.
    assert.doesNotThrow(() => handle.cleanup());
    assert.equal(destroyed, 1, 'second cleanup is a no-op');
  } finally {
    try { db.close(); } catch (_) { /* may already be closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
