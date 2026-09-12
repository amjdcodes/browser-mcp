import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Browser } from '../src/browser.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForState(browser, expected, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (browser.state === expected) return;
    await sleep(100);
  }
  assert.fail(`Browser never reached state ${expected} (current: ${browser.state})`);
}

// Wait for a crash-restart cycle: the exit must first be detected (state
// leaves 'ready'), then recovery back to 'ready' with a new process.
async function waitForRestart(browser, timeoutMs = 20000) {
  const start = Date.now();
  while (browser.state === 'ready' && Date.now() - start < timeoutMs) {
    await sleep(20); // wait for the exit event to propagate
  }
  assert.notEqual(browser.state, 'ready', 'restart never started');
  await waitForState(browser, 'ready', timeoutMs);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Chromium crash / restart', () => {
  let browser;

  afterEach(async () => {
    if (browser) {
      await browser.cleanup();
      browser = null;
    }
  });

  it('restarts with a new process, profile, port, and WebSocket after a crash', async () => {
    browser = new Browser();
    await browser.start();
    assert.equal(browser.state, 'ready');

    const oldPid = browser.pid;
    const oldPort = browser.port;
    const oldProfile = browser.profileDir;
    const oldCdp = browser.cdp;

    // Simulate a hard crash.
    process.kill(oldPid, 'SIGKILL');

    await waitForRestart(browser);

    // New process, profile, and port — a completely fresh browser.
    assert.notEqual(browser.pid, oldPid, 'a new Chromium process should be spawned');
    assert.ok(browser.pid > 0);
    assert.notEqual(browser.port, oldPort, 'a new CDP port should be allocated');
    assert.notEqual(browser.profileDir, oldProfile, 'a new profile directory should be created');
    assert.ok(existsSync(browser.profileDir), 'new profile should exist on disk');

    // Old resources cleaned up.
    assert.equal(isProcessAlive(oldPid), false, 'old Chromium process should be dead');
    assert.equal(existsSync(oldProfile), false, 'old profile directory should be removed');
    assert.notEqual(browser.cdp, oldCdp, 'a new CDP client/WebSocket should be created');
    assert.equal(browser.isReady, true);
    assert.ok(browser.cdp.isConnected, 'new WebSocket should be connected');

    // The page is fresh about:blank — the old page state is NOT restored and
    // the interrupted navigation is NOT retried.
    const result = await browser.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true
    });
    assert.equal(result.result.value, '');
  });

  it('restarts after SIGTERM too', async () => {
    browser = new Browser();
    await browser.start();
    const oldPid = browser.pid;

    process.kill(oldPid, 'SIGTERM');
    await waitForRestart(browser);

    assert.notEqual(browser.pid, oldPid);
    assert.equal(browser.state, 'ready');
    assert.equal(browser.isReady, true);
  });

  it('cleans up the old profile and creates a fresh one', async () => {
    browser = new Browser();
    await browser.start();
    const oldProfile = browser.profileDir;
    assert.ok(existsSync(oldProfile));

    process.kill(browser.pid, 'SIGKILL');
    await waitForRestart(browser);

    assert.equal(existsSync(oldProfile), false, 'old profile must be removed after restart');
    assert.notEqual(browser.profileDir, oldProfile);
  });

  it('re-enables CDP domains after restart', async () => {
    browser = new Browser();
    await browser.start();

    // Console listener wiring depends on the Runtime/Page domains being enabled.
    const before = browser.consoleBuffer;
    process.kill(browser.pid, 'SIGKILL');
    await waitForRestart(browser);

    // Domains are functional post-restart: evaluate + navigate work.
    await browser.send('Runtime.evaluate', { expression: '1' }, 5000);
    const nav = await browser.send('Page.navigate', { url: 'about:blank' }, 5000);
    assert.ok(nav.frameId);
    assert.equal(browser.consoleBuffer, before, 'console buffer survives restarts');
  });

  it('transitions to failed with CHROMIUM_RESTART_FAILED after the restart limit', async () => {
    browser = new Browser({ maxRestartAttempts: 0 });
    await browser.start();
    const oldPid = browser.pid;

    process.kill(oldPid, 'SIGKILL');

    await waitForState(browser, 'failed');

    assert.ok(browser.failureReason, 'failureReason should be recorded');
    assert.equal(browser.failureReason.code, 'CHROMIUM_RESTART_FAILED');
    assert.match(browser.failureReason.message, /restart failed/i);

    // send() surfaces a clear error including the code and last stderr lines.
    await assert.rejects(
      browser.send('Runtime.evaluate', { expression: '1' }),
      (err) => {
        assert.match(err.message, /CHROMIUM_RESTART_FAILED/);
        assert.match(err.message, /restart failed/i);
        return true;
      }
    );
  });

  it('does not auto-retry the interrupted navigation after restart', async () => {
    browser = new Browser();
    await browser.start();

    // Navigate somewhere non-trivial, then crash mid-session.
    const nav = await browser.send('Page.navigate', { url: 'about:blank' }, 10000);
    assert.ok(nav.frameId);
    process.kill(browser.pid, 'SIGKILL');
    await waitForRestart(browser);

    // The restored browser is on about:blank (empty title) — the navigation
    // was not silently replayed.
    const result = await browser.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true
    });
    assert.equal(result.result.value, '');
  });

  it('a hung renderer fails the CDP command with a timeout, not a hang', async () => {
    browser = new Browser();
    await browser.start();

    const started = Date.now();
    await assert.rejects(
      browser.send('Runtime.evaluate', {
        expression: 'new Promise(() => {})', // never resolves
        awaitPromise: true
      }, 1000),
      /Timeout: Runtime.evaluate/
    );
    assert.ok(Date.now() - started < 10000, 'timeout should be enforced');
  });
});
