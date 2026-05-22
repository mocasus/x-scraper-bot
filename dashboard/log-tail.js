/**
 * Tail a single log file and emit a callback per appended line.
 *
 * Implementation notes:
 *
 * - We watch the *parent directory* (not the file) so the contract holds
 *   when the file does not yet exist or is rotated/recreated under us.
 * - When the file exists at startup we record its current size as the
 *   tail offset; we do NOT replay history. Subsequent writes are read
 *   from that offset onward.
 * - On each filesystem event we statSync the file, read the size
 *   delta into a Buffer, append to a leftover string, and split on
 *   '\n'. Trailing partial lines are kept until the next event closes
 *   them with a newline.
 * - If the file shrinks (truncation) we reset the offset to 0 and
 *   discard any leftover.
 * - Filesystem operations during rotation can race with us; every
 *   stat/open/read is wrapped in try/catch and a failed cycle is
 *   silently skipped.
 *
 * Requiring this module has zero side effects: no fs.watch is created
 * until tailLog() is actually called.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024;

/**
 * Begin tailing `filePath`. `onLine(line)` is invoked once per complete
 * line (no trailing newline). Returns `{ stop() }` which is always safe
 * to call (idempotent, never throws).
 *
 * Optional `opts`:
 *   maxBufferBytes  Cap for any single read chunk (default 64 KiB).
 *                   When exceeded, the leftover buffer is discarded
 *                   and onError is invoked.
 *   onError(err)    Called for non-fatal warnings (oversized reads).
 *                   Defaults to a no-op so the tail stays silent in
 *                   the dashboard's status panel.
 */
function tailLog(filePath, onLine, opts) {
  const options = opts || {};
  const maxBufferBytes = Number.isFinite(options.maxBufferBytes)
    ? Math.floor(options.maxBufferBytes)
    : DEFAULT_MAX_BUFFER_BYTES;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const emit = typeof onLine === 'function' ? onLine : () => {};

  const absPath = path.resolve(filePath);
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);

  let dirWatcher = null;
  let fileWatcher = null;
  let offset = 0;
  let leftover = '';
  let stopped = false;
  let attached = false;

  // Drain whatever new bytes have arrived since `offset`. Safe to call
  // when the file does not yet exist (silently skips the cycle).
  function drain() {
    if (stopped) return;
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (_err) {
      // File missing or transient error - ignore until the next event.
      return;
    }
    const size = stat.size;
    if (size < offset) {
      // Truncation/rotation - reset to the new file's start.
      offset = 0;
      leftover = '';
    }
    if (size === offset) return;

    const toRead = size - offset;
    if (toRead > maxBufferBytes) {
      try {
        onError(
          Object.assign(new Error('log-tail read exceeds maxBufferBytes; resetting'), {
            code: 'ERR_LOG_TAIL_OVERFLOW',
            requested: toRead,
            limit: maxBufferBytes,
          })
        );
      } catch (_e) {
        // Swallow user errors so the tail stays alive.
      }
      // Skip ahead to the current end-of-file and drop any partial line.
      offset = size;
      leftover = '';
      return;
    }

    let fd;
    try {
      fd = fs.openSync(absPath, 'r');
    } catch (_err) {
      return;
    }

    try {
      const buf = Buffer.alloc(toRead);
      let bytesRead;
      try {
        bytesRead = fs.readSync(fd, buf, 0, toRead, offset);
      } catch (_err) {
        return;
      }
      if (!bytesRead || bytesRead <= 0) return;
      offset += bytesRead;

      leftover += buf.slice(0, bytesRead).toString('utf8');
      const parts = leftover.split('\n');
      // The last element is either '' (clean newline boundary) or a
      // trailing partial line; carry it forward either way.
      leftover = parts.pop();
      for (const line of parts) {
        try {
          emit(line);
        } catch (_e) {
          // User callback errors must not kill the tailer.
        }
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch (_err) {
        // ignore
      }
    }
  }

  function attachFileWatcher() {
    if (attached || stopped) return;
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (_err) {
      return;
    }
    offset = stat.size;
    leftover = '';

    try {
      fileWatcher = fs.watch(absPath, (eventType) => {
        if (stopped) return;
        if (eventType === 'rename') {
          // The file was rotated/removed; fall back to the directory
          // watcher to pick the next instance up.
          try {
            if (fileWatcher) fileWatcher.close();
          } catch (_e) {
            // ignore
          }
          fileWatcher = null;
          attached = false;
          offset = 0;
          leftover = '';
          return;
        }
        drain();
      });
      attached = true;
    } catch (_err) {
      attached = false;
      fileWatcher = null;
    }
  }

  // Watch the directory unconditionally so we can detect the file
  // appearing later (or being recreated after rotation).
  try {
    dirWatcher = fs.watch(dir, (_eventType, filename) => {
      if (stopped) return;
      if (filename && filename !== base) return;
      if (!attached) {
        attachFileWatcher();
        // After attaching, drain any data that was already there at
        // attach time only beyond `offset` (which we set to current
        // size). For truly fresh files attached() set offset=0 so the
        // first line will be emitted on the next change event.
      } else {
        drain();
      }
    });
  } catch (_err) {
    // If we can't watch the directory there's nothing else to do; the
    // returned stop() handle is still valid.
    dirWatcher = null;
  }

  // If the file already exists, attach immediately.
  attachFileWatcher();

  function stop() {
    if (stopped) return;
    stopped = true;
    try {
      if (fileWatcher) fileWatcher.close();
    } catch (_e) {
      // ignore
    }
    try {
      if (dirWatcher) dirWatcher.close();
    } catch (_e) {
      // ignore
    }
    fileWatcher = null;
    dirWatcher = null;
    leftover = '';
    offset = 0;
  }

  return { stop };
}

module.exports = { tailLog };
