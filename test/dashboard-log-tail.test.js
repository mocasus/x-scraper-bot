'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { tailLog } = require('../dashboard/log-tail.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait until the predicate returns truthy, polling every 25ms. Bounded
// at 1500ms so a flaky watcher cannot blow the 5s suite budget.
async function waitFor(pred, timeoutMs) {
  const limit = timeoutMs == null ? 1500 : timeoutMs;
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (pred()) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(25);
  }
  return pred();
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-log-tail-'));
}

function rmTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('tailLog with a missing file does not throw and stop() is callable', () => {
  const dir = mkTmpDir();
  try {
    const ghost = path.join(dir, 'nope.log');
    let lineCount = 0;
    const handle = tailLog(ghost, () => {
      lineCount += 1;
    });
    assert.equal(typeof handle.stop, 'function');
    handle.stop();
    // calling stop() twice is also safe.
    handle.stop();
    assert.equal(lineCount, 0);
  } finally {
    rmTmpDir(dir);
  }
});

test('tailLog emits one callback per appended line on a pre-existing empty file', async () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'app.log');
  fs.writeFileSync(file, '');
  const lines = [];
  const handle = tailLog(file, (line) => {
    lines.push(line);
  });
  try {
    fs.appendFileSync(file, '{"hello":"world"}\n');
    await waitFor(() => lines.length >= 1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '{"hello":"world"}'); // no trailing newline

    fs.appendFileSync(file, 'second line\nthird line\n');
    await waitFor(() => lines.length >= 3);
    assert.equal(lines.length, 3);
    assert.equal(lines[1], 'second line');
    assert.equal(lines[2], 'third line');
  } finally {
    handle.stop();
    rmTmpDir(dir);
  }
});

test('tailLog batched append in a single write fires callback for every line', async () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'app.log');
  fs.writeFileSync(file, '');
  const lines = [];
  const handle = tailLog(file, (line) => {
    lines.push(line);
  });
  try {
    fs.appendFileSync(file, 'a\nb\nc\n');
    await waitFor(() => lines.length >= 3);
    assert.deepEqual(lines, ['a', 'b', 'c']);
  } finally {
    handle.stop();
    rmTmpDir(dir);
  }
});

test('tailLog stop() halts further callbacks', async () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'app.log');
  fs.writeFileSync(file, '');
  const lines = [];
  const handle = tailLog(file, (line) => {
    lines.push(line);
  });
  try {
    fs.appendFileSync(file, 'one\n');
    await waitFor(() => lines.length >= 1);
    assert.equal(lines.length, 1);

    handle.stop();
    fs.appendFileSync(file, 'two\nthree\n');
    // Give the watcher time to NOT fire.
    await sleep(250);
    assert.equal(lines.length, 1, 'no further callbacks after stop()');
  } finally {
    handle.stop();
    rmTmpDir(dir);
  }
});

test('tailLog picks up a file that is created after watching starts', async () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'late.log');
  const lines = [];
  const handle = tailLog(file, (line) => {
    lines.push(line);
  });
  try {
    // File doesn't exist yet; create it and append in two steps to give
    // both the directory watcher and the file watcher a chance to fire.
    fs.writeFileSync(file, '');
    await sleep(100);
    fs.appendFileSync(file, 'born late\n');
    await waitFor(() => lines.length >= 1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], 'born late');
  } finally {
    handle.stop();
    rmTmpDir(dir);
  }
});

test('tailLog handles file truncation (size shrink resets offset)', async () => {
  const dir = mkTmpDir();
  const file = path.join(dir, 'rotating.log');
  // Pre-seed with content so we have a non-zero starting offset.
  fs.writeFileSync(file, 'history line should be ignored\n');
  const lines = [];
  const handle = tailLog(file, (line) => {
    lines.push(line);
  });
  try {
    // First, append a line so we know the tail is live.
    fs.appendFileSync(file, 'live line\n');
    await waitFor(() => lines.length >= 1);
    assert.equal(lines[0], 'live line');

    // Truncate the file and append fresh content.
    fs.writeFileSync(file, '');
    await sleep(100);
    fs.appendFileSync(file, 'after truncate\n');
    await waitFor(() => lines.length >= 2);
    assert.equal(lines.length, 2);
    assert.equal(lines[1], 'after truncate');
  } finally {
    handle.stop();
    rmTmpDir(dir);
  }
});
