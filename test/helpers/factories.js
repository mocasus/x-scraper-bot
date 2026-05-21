/**
 * Shared test factories. Build isolated bot.js dependencies (config, db,
 * logger, http) on demand so individual tests stay deterministic and
 * never touch the real ./data or ./logs directories.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig, createDb, createLogger } = require('../../bot.js');

// Synthetic env that yields the documented defaults via loadConfig().
const DEFAULT_ENV = Object.freeze({});

function freshConfig(overrides) {
  return loadConfig({ ...DEFAULT_ENV, ...(overrides || {}) });
}

function inMemoryDb() {
  return createDb({ path: ':memory:' });
}

function silentLogger() {
  const file = path.join(
    os.tmpdir(),
    `bot-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`
  );
  // Capture console output instead of letting it leak into test output.
  const calls = { log: [], warn: [], error: [] };
  const fakeConsole = {
    log: (...args) => calls.log.push(args.join(' ')),
    warn: (...args) => calls.warn.push(args.join(' ')),
    error: (...args) => calls.error.push(args.join(' ')),
  };
  const logger = createLogger({ logFile: file, console: fakeConsole });
  return { logger, file, calls };
}

function readLogLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function mockHttp(spec) {
  const cfg = spec || {};
  const calls = [];
  return {
    calls,
    post(url, body, opts) {
      calls.push({ url, body, opts });
      if (cfg.throws) {
        return Promise.reject(cfg.throws);
      }
      return Promise.resolve({
        status: cfg.status != null ? cfg.status : 200,
        data: cfg.data != null ? cfg.data : { id: 'mock-msg-id' },
      });
    },
  };
}

module.exports = {
  freshConfig,
  inMemoryDb,
  silentLogger,
  readLogLines,
  mockHttp,
};
