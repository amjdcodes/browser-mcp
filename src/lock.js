// src/lock.js
// ---------------------------------------------------------------------------
// Operation lock: a single mutex that serializes state-changing browser
// operations (browser_click, browser_type, browser_navigate, full-page
// screenshots) so they never interleave.
//
// Features:
//   - FIFO queue with a maximum size (CONFIG.QUEUE_LIMIT = 8)
//   - Throws BUSY_QUEUE_FULL when the queue is at capacity
//   - Maximum lock duration backstop to prevent deadlocks
//   - Guaranteed release via a release() function (callers use try/finally)
// ---------------------------------------------------------------------------

import { CONFIG } from './utils.js';

const DEFAULT_MAX_QUEUE = CONFIG.QUEUE_LIMIT || 8;
// Backstop: if an operation holds the lock longer than this, force-release so
// queued operations cannot deadlock. Operations have their own internal
// timeouts (max 120s), so this rarely triggers in practice.
const DEFAULT_MAX_DURATION_MS = 300000; // 5 minutes

export class OperationLock {
  constructor(options = {}) {
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this._queue = [];
    this._active = false;
    this._holderSince = 0;
    this._watchdog = null;
    this._overruns = 0;
  }

  /** Number of operations in the queue, including the one currently holding the lock. */
  get queueLength() {
    return this._queue.length;
  }

  /** True while an operation holds the lock. */
  get locked() {
    return this._active;
  }

  /**
   * Acquire the lock. Resolves with a `release()` function once this request
   * reaches the front of the queue. Rejects with code BUSY_QUEUE_FULL when the
   * queue is at capacity (active operation + waiting requests).
   */
  acquire() {
    if (this._queue.length >= this.maxQueue) {
      const err = new Error(
        `Operation queue is full (max ${this.maxQueue}). Try again later.`
      );
      err.code = 'BUSY_QUEUE_FULL';
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      this._queue.push({ resolve, reject, active: false });
      this._pump();
    });
  }

  _pump() {
    if (this._active) return;

    const entry = this._queue.find(e => !e.active);
    if (!entry) return;

    entry.active = true;
    this._active = true;
    this._holderSince = Date.now();

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (this._watchdog) {
        clearTimeout(this._watchdog);
        this._watchdog = null;
      }
      const idx = this._queue.indexOf(entry);
      if (idx !== -1) this._queue.splice(idx, 1);
      this._active = false;
      this._pump();
    };

    if (this.maxDurationMs > 0) {
      this._watchdog = setTimeout(() => {
        if (this._active && !released) {
          this._overruns++;
          process.stderr.write(
            `[Lock] Operation held lock > ${this.maxDurationMs}ms; force-releasing (overrun #${this._overruns})\n`
          );
          release();
        }
      }, this.maxDurationMs);
    }

    entry.resolve(release);
  }
}

/**
 * Run `fn` under the operation lock. The lock is released in a finally block,
 * so it is released on success, on error, and on timeout alike.
 */
export async function withLock(lock, fn) {
  const release = await lock.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

export default OperationLock;
