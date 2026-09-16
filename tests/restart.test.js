import { describe, it, after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Browser } from '../src/browser.js';
import {
  startFixtureServer,
  startMcpServer,
  stopServer,
  initializeServer,
  makeCallTool
} from './harness.js';

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

  it('restarts with a new process and WebSocket after a crash', async () => {
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

    // New process, port and WebSocket — but the SAME profile directory, so the
    // page's stored state (localStorage, session storage, cookies) survives.
    assert.notEqual(browser.pid, oldPid, 'a new Chromium process should be spawned');
    assert.ok(browser.pid > 0);
    assert.notEqual(browser.port, oldPort, 'a new CDP port should be allocated');
    assert.equal(browser.profileDir, oldProfile, 'the profile directory must be reused');
    assert.ok(existsSync(browser.profileDir), 'the profile should still exist on disk');

    // Old process cleaned up.
    assert.equal(isProcessAlive(oldPid), false, 'old Chromium process should be dead');
    assert.notEqual(browser.cdp, oldCdp, 'a new CDP client/WebSocket should be created');
    assert.equal(browser.isReady, true);
    assert.ok(browser.cdp.isConnected, 'new WebSocket should be connected');

    // The client is told once that the session was reset.
    assert.equal(browser.consumeSessionReset(), true, 'the reset must be reported');
    assert.equal(browser.consumeSessionReset(), false, 'the reset is reported only once');

    // The page is fresh about:blank — the interrupted navigation is NOT retried.
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

  it('keeps the profile directory, and its contents, across a restart', async () => {
    browser = new Browser();
    await browser.start();
    const profile = browser.profileDir;
    assert.ok(existsSync(profile));

    // Stands in for the browser's own on-disk state (localStorage leveldb,
    // cookies): it must outlive the crash restart.
    const marker = join(profile, 'state-marker');
    writeFileSync(marker, 'kept');

    process.kill(browser.pid, 'SIGKILL');
    await waitForRestart(browser);

    assert.equal(browser.profileDir, profile, 'the same profile must be reused');
    assert.ok(existsSync(marker), 'the profile contents must survive the restart');
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

// ---------------------------------------------------------------------------
// The MCP layer must tell the client that a crash wiped the page, instead of
// letting it draw conclusions from a page it never saw reset.
// ---------------------------------------------------------------------------

describe('Crash restart reporting', () => {
  let fixture;
  let state;
  let call;

  before(async () => {
    fixture = await startFixtureServer();
    state = startMcpServer();
    await initializeServer(state, 'restart-report-test');
    call = makeCallTool(state);
    await call('browser_navigate', { url: `http://127.0.0.1:${fixture.port}/` });
  });

  after(async () => {
    await stopServer(state);
    fixture.server.close();
  });

  function sessionResetNotes(response) {
    return (response.result.content || [])
      .filter(part => typeof part.text === 'string')
      .map(part => part.text)
      .filter(text => text.includes('sessionReset'));
  }

  it('reports the reset once, on the first call after the crash', async () => {
    const pid = parseInt(state.stderr.match(/Chromium PID: (\d+)/)[1], 10);
    const readyCount = () => (state.stderr.match(/\[Browser\] Ready on port/g) || []).length;

    const readyBefore = readyCount();
    process.kill(pid, 'SIGKILL');

    const deadline = Date.now() + 60000;
    while (readyCount() === readyBefore && Date.now() < deadline) {
      await sleep(100);
    }
    assert.ok(readyCount() > readyBefore, 'the browser never came back after the crash');

    // The first call after the restart is the one that must report the reset.
    const afterCrash = await call('browser_get_url', {}, 60000);
    assert.notEqual(afterCrash.result.isError, true);
    assert.equal(sessionResetNotes(afterCrash).length, 1, 'the reset must be reported');
    assert.equal(JSON.parse(afterCrash.result.content[0].text).url, 'about:blank',
      'the restarted browser is on about:blank');

    const next = await call('browser_get_url', {});
    assert.equal(sessionResetNotes(next).length, 0, 'the reset must not be reported twice');
  });
});
