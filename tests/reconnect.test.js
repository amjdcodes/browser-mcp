import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../src/browser.js';
import { CDPClient } from '../src/cdp.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForState(browser, expected, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (browser.state === expected) return;
    await sleep(100);
  }
  assert.fail(`Browser never reached state ${expected} (current: ${browser.state})`);
}

// Wait for a reconnect cycle to complete: the socket drop must first be
// detected (state leaves 'ready'), then recovery back to 'ready'.
async function waitForReconnect(browser, timeoutMs = 15000) {
  const start = Date.now();
  while (browser.state === 'ready' && Date.now() - start < timeoutMs) {
    await sleep(20); // wait for the close event to propagate
  }
  assert.notEqual(browser.state, 'ready', 'reconnect never started');
  await waitForState(browser, 'ready', timeoutMs);
}

describe('WebSocket disconnect / reconnect', () => {
  let browser;

  afterEach(async () => {
    if (browser) {
      await browser.cleanup();
      browser = null;
    }
  });

  it('reconnects to the same Chromium process after a WebSocket drop', async () => {
    browser = new Browser();
    await browser.start();
    assert.equal(browser.state, 'ready');

    const originalPid = browser.pid;
    const originalPort = browser.port;
    const originalProfile = browser.profileDir;

    // Simulate a network failure: hard-terminate the WebSocket (not graceful
    // close, not process death).
    browser.cdp.ws.terminate();

    // Pending/next CDP work must fail fast (browser not ready while reconnecting).
    await assert.rejects(
      browser.send('Runtime.evaluate', { expression: '1' }, 2000),
      /not ready|reconnecting|WebSocket|Not connected/i
    );

    await waitForReconnect(browser);

    // Reconnected to the SAME process: same PID, port, and profile — no restart.
    assert.equal(browser.pid, originalPid, 'PID changed — process was restarted');
    assert.equal(browser.port, originalPort, 'port changed — process was restarted');
    assert.equal(browser.profileDir, originalProfile, 'profile changed — process was restarted');
    assert.equal(browser.isReady, true);
    assert.ok(browser.cdp.isConnected, 'new WebSocket should be connected');

    // The browser is fully functional again.
    const result = await browser.send('Runtime.evaluate', { expression: '6 * 7' });
    assert.equal(result.result.value, 42);
  });

  it('rejects pending CDP requests immediately when the socket drops', async () => {
    browser = new Browser();
    await browser.start();

    // A long-running in-page await keeps the CDP request pending.
    const pending = browser.send('Runtime.evaluate', {
      expression: 'new Promise(r => setTimeout(() => r("done"), 10000))',
      awaitPromise: true,
      returnByValue: true
    }, 20000);

    await sleep(300); // let the request reach the browser

    browser.cdp.ws.terminate();

    const started = Date.now();
    await assert.rejects(pending, /WebSocket closed/i);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `pending request took ${elapsed}ms to reject`);

    // Reconnection still succeeds afterwards.
    await waitForReconnect(browser);
  });

  it('uses exponential backoff between reconnect attempts', async () => {
    browser = new Browser();
    await browser.start();

    // Force the first two connect attempts to fail, then allow real reconnect.
    let failuresRemaining = 2;
    const originalConnect = browser._connectToPage.bind(browser);
    browser._connectToPage = async () => {
      if (failuresRemaining > 0) {
        failuresRemaining--;
        throw new Error('simulated connect failure');
      }
      return originalConnect();
    };

    const startTime = Date.now();
    browser.cdp.ws.terminate();
    await waitForReconnect(browser);

    // Attempt 1 fails after ~100ms backoff, attempt 2 after ~200ms, attempt 3
    // succeeds: total should exceed the sum of the first two backoffs.
    const elapsed = Date.now() - startTime;
    assert.ok(elapsed >= 250, `reconnected too fast (${elapsed}ms) — no backoff?`);
    assert.ok(failuresRemaining === 0, 'simulated failures were not all consumed');
    assert.equal(browser.reconnectAttempts, 0, 'attempt counter should reset after success');
  });

  it('transitions to failed state after exceeding the reconnect limit', async () => {
    browser = new Browser({ maxReconnectAttempts: 1 });
    await browser.start();

    // Make every reconnect attempt fail.
    browser._connectToPage = async () => {
      throw new Error('simulated permanent connect failure');
    };

    browser.cdp.ws.terminate();

    await waitForState(browser, 'failed');
    assert.ok(browser.failureReason, 'failureReason should be recorded');
    assert.match(browser.failureReason.message, /Reconnection failed/i);

    // send() must surface a clear error, not hang or retry.
    await assert.rejects(
      browser.send('Runtime.evaluate', { expression: '1' }),
      /simulated permanent connect failure/
    );
  });

  it('does not retry the operation that was interrupted by the disconnect', async () => {
    browser = new Browser();
    await browser.start();

    // A state-changing operation: navigate. It completes before the drop.
    await browser.send('Page.navigate', { url: 'about:blank' }, 10000);

    // Now interrupt: terminate the socket.
    browser.cdp.ws.terminate();

    // The next send during reconnect must fail (no hidden auto-retry)...
    await assert.rejects(
      browser.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, 2000),
      /not ready|reconnecting|WebSocket|Not connected/i
    );

    // ...and after reconnect, the operation is NOT replayed: the page is still
    // about:blank with an empty title (nothing was re-executed).
    await waitForReconnect(browser);
    const result = await browser.send('Runtime.evaluate', {
      expression: 'document.title', returnByValue: true
    });
    assert.equal(result.result.value, '');
  });

  it('CDPClient rejects all pending requests on close', async () => {
    browser = new Browser();
    await browser.start();

    // Open an independent second CDP connection to the same Chromium.
    const list = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    const client = new CDPClient();
    await client.connect(page.webSocketDebuggerUrl);

    const pending = client.send('Runtime.evaluate', {
      expression: 'new Promise(r => setTimeout(() => r(1), 10000))',
      awaitPromise: true
    }, 20000);
    await sleep(200);
    assert.equal(client.pendingCount, 1);

    client.ws.terminate();
    await assert.rejects(pending, /WebSocket closed/i);
    assert.equal(client.pendingCount, 0);
  });
});
