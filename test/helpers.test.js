'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  tweetIdFromHref,
  usernameFromHref,
  parseBool,
  parseIntClamped,
} = require('../bot.js');

test('tweetIdFromHref: extracts numeric id from full twitter.com URL', () => {
  assert.equal(tweetIdFromHref('https://twitter.com/elonmusk/status/123'), '123');
});

test('tweetIdFromHref: extracts numeric id from full x.com URL', () => {
  assert.equal(tweetIdFromHref('https://x.com/whale_alert/status/456'), '456');
});

test('tweetIdFromHref: extracts numeric id from a relative path', () => {
  assert.equal(tweetIdFromHref('/elonmusk/status/789'), '789');
});

test('tweetIdFromHref: extracts only digits when trailing query string is present', () => {
  assert.equal(
    tweetIdFromHref('https://x.com/u/status/12345?ref=foo'),
    '12345'
  );
});

test('tweetIdFromHref: returns the input verbatim when /status/ is missing', () => {
  assert.equal(
    tweetIdFromHref('https://example.com/foo'),
    'https://example.com/foo'
  );
});

test('tweetIdFromHref: returns null for null', () => {
  assert.equal(tweetIdFromHref(null), null);
});

test('tweetIdFromHref: returns null for undefined', () => {
  assert.equal(tweetIdFromHref(undefined), null);
});

test('tweetIdFromHref: returns null for empty string', () => {
  assert.equal(tweetIdFromHref(''), null);
});

test('usernameFromHref: lowercases the path[0] segment', () => {
  assert.equal(
    usernameFromHref('https://twitter.com/ElonMusk/status/1'),
    'elonmusk'
  );
});

test('usernameFromHref: handles x.com host', () => {
  assert.equal(
    usernameFromHref('https://x.com/Whale_Alert/status/2'),
    'whale_alert'
  );
});

test('usernameFromHref: returns null for null', () => {
  assert.equal(usernameFromHref(null), null);
});

test('usernameFromHref: returns null for undefined', () => {
  assert.equal(usernameFromHref(undefined), null);
});

test('usernameFromHref: returns null for an unparsable URL string', () => {
  assert.equal(usernameFromHref('not-a-url'), null);
});

test('usernameFromHref: returns null for empty string', () => {
  assert.equal(usernameFromHref(''), null);
});

test('usernameFromHref: returns null for a bare path with no host', () => {
  assert.equal(usernameFromHref('/just/path'), null);
});

test('parseBool: returns fallback for undefined', () => {
  assert.equal(parseBool(undefined, true), true);
  assert.equal(parseBool(undefined, false), false);
});

test('parseBool: returns fallback for null', () => {
  assert.equal(parseBool(null, true), true);
});

test('parseBool: returns fallback for empty string', () => {
  assert.equal(parseBool('', true), true);
  assert.equal(parseBool('', false), false);
});

test('parseBool: parses canonical "true" as true regardless of case', () => {
  assert.equal(parseBool('true', false), true);
  assert.equal(parseBool('TRUE', false), true);
  assert.equal(parseBool('True', false), true);
});

test('parseBool: parses anything else as false', () => {
  assert.equal(parseBool('false', true), false);
  assert.equal(parseBool('yes', true), false);
  assert.equal(parseBool('1', true), false);
  assert.equal(parseBool('0', true), false);
});

test('parseIntClamped: returns fallback for non-numeric strings', () => {
  assert.equal(parseIntClamped('abc', 5, 1), 5);
  assert.equal(parseIntClamped(undefined, 7, 1), 7);
  assert.equal(parseIntClamped(null, 9, 1), 9);
  assert.equal(parseIntClamped('', 11, 1), 11);
});

test('parseIntClamped: clamps values below min', () => {
  assert.equal(parseIntClamped('0', 5, 1), 1);
  assert.equal(parseIntClamped('-5', 5, 1), 1);
  assert.equal(parseIntClamped('-100', 5000, 1000), 1000);
});

test('parseIntClamped: passes through valid values >= min', () => {
  assert.equal(parseIntClamped('10', 5, 1), 10);
  assert.equal(parseIntClamped('1', 5, 1), 1);
  assert.equal(parseIntClamped('5000', 5000, 1000), 5000);
});

test('parseIntClamped: parses leading-integer numeric strings', () => {
  // parseInt('10abc', 10) === 10 by spec
  assert.equal(parseIntClamped('10abc', 5, 1), 10);
});
