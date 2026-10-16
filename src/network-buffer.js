// src/network-buffer.js
// ---------------------------------------------------------------------------
// Ring buffer for browser network activity, modelled directly on
// src/console-buffer.js.
//
// The Network CDP domain is already enabled at browser start (src/browser.js),
// but no permanent listener consumed its events: a request issued by the page
// after load (fetch/XHR) failed silently — leaving no trace in the console or
// the DOM. This buffer records those requests (method, URL, status, failure)
// so browser_network can report them.
//
// PRIVACY: URLs may carry tokens in the query string, so a URL is NEVER written
// to stderr — the same policy the console buffer follows.
//
// MEMORY: two bounds keep this surprising-free. `maxRequests` caps the finished
// record (oldest evicted, like ConsoleBuffer.add); a second bound evicts the
// oldest *pending* entries when they exceed the record cap, so a request whose
// finish/fail event never arrives cannot grow `pending` without limit.
// ---------------------------------------------------------------------------

import { truncateConsole, CONFIG } from './utils.js';

export class NetworkBuffer {
  constructor(maxRequests = CONFIG.MAX_NETWORK_REQUESTS || 200) {
    this.buffer = [];
    this.pending = new Map();
    this.maxRequests = maxRequests;
  }

  /** Network.requestWillBeSent — start tracking a request. */
  start(params) {
    if (!params || !params.requestId) return;
    const request = params.request || {};
    this.pending.set(params.requestId, {
      requestId: params.requestId,
      method: request.method || null,
      url: request.url || null,
      resourceType: params.type || null,
      timestamp: params.wallTime ?? null,
      status: null,
      mimeType: null,
      failure: null,
      canceled: false,
      completed: false
    });

    // Evict the oldest pending entries if the map has outgrown the record cap:
    // a request whose finish/fail event never arrives must not leak.
    while (this.pending.size > this.maxRequests) {
      const oldestKey = this.pending.keys().next().value;
      const entry = this.pending.get(oldestKey);
      this.pending.delete(oldestKey);
      this.add(entry);
    }
  }

  /** Network.responseReceived — attach the HTTP status to a pending request. */
  respond(params) {
    if (!params || !params.requestId) return;
    const entry = this.pending.get(params.requestId);
    if (!entry || !params.response) return;
    entry.status = params.response.status ?? null;
    entry.mimeType = params.response.mimeType ?? null;
  }

  /** Network.loadingFailed — record a network-level failure (or cancel). */
  fail(params) {
    if (!params || !params.requestId) return;
    const entry = this.pending.get(params.requestId);
    if (!entry) return;
    this.pending.delete(params.requestId);
    entry.failure = params.errorText || 'unknown';
    entry.canceled = params.canceled === true;
    this.add(entry);
  }

  /** Network.loadingFinished — move a completed request into the record. */
  finish(params) {
    if (!params || !params.requestId) return;
    const entry = this.pending.get(params.requestId);
    if (!entry) return;
    this.pending.delete(params.requestId);
    entry.completed = true;
    this.add(entry);
  }

  add(entry) {
    if (!entry) return;
    this.buffer.push(entry);
    if (this.buffer.length > this.maxRequests) {
      this.buffer.shift();
    }
  }

  clear() {
    this.buffer = [];
    this.pending.clear();
  }

  /** A request failed when it errored at the network level or returned >= 400. */
  static isFailed(entry) {
    if (!entry) return false;
    if (entry.failure) return true;
    return typeof entry.status === 'number' && entry.status >= 400;
  }

  getRequests(filter = 'all') {
    if (filter === 'failed') {
      return this.buffer.filter(NetworkBuffer.isFailed);
    }
    return [...this.buffer];
  }

  getFormatted(filter = 'all', clearAfter = false) {
    const requests = this.getRequests(filter);
    const truncated = truncateConsole(requests, CONFIG.MAX_NETWORK_LINES);
    const failedCount = this.buffer.filter(NetworkBuffer.isFailed).length;

    if (clearAfter) {
      this.clear();
    }

    return {
      requests: truncated.lines,
      count: requests.length,
      failedCount,
      cleared: clearAfter,
      truncated: truncated.truncated,
      droppedCount: truncated.droppedCount || 0
    };
  }
}

export default NetworkBuffer;
