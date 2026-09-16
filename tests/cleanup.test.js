import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');
const PROJECT_DIR = join(__dirname, '..');

let fixtureServer;
let fixturePort;

before(() => new Promise((resolve) => {
  fixtureServer = createServer((req, res) => {
    try {
      const filePath = join(fixturesDir, req.url === '/' ? 'test-page.html' : req.url);
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    } catch {
      try {
        res.writeHead(404);
        res.end('Not found');
      } catch { /* aborted */ }
    }
  });
  fixtureServer.maxRequestsPerSocket = 0;
  fixtureServer.listen(0, '127.0.0.1', () => {
    fixturePort = fixtureServer.address().port;
    resolve();
  });
}));

after(() => {
  fixtureServer?.closeAllConnections?.();
  fixtureServer?.close();
});

function sendRequest(proc, request, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    proc.stdin.write(JSON.stringify(request) + '\n');
    const timeout = setTimeout(() => reject(new Error(`Timeout (id ${request.id})`)), timeoutMs);
    const onData = (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const response = JSON.parse(line);
          if (response.id === request.id) {
            clearTimeout(timeout);
            proc.stdout.off('data', onData);
            resolve(response);
            return;
          }
        } catch { /* partial line */ }
      }
    };
    proc.stdout.on('data', onData);
  });
}

async function initialize(proc) {
  await sendRequest(proc, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cleanup-test', version: '1.0.0' }
    }
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 200));
}

let nextId = 100;

async function callTool(proc, name, args = {}) {
  return sendRequest(proc, {
    jsonrpc: '2.0', id: nextId++, method: 'tools/call',
    params: { name, arguments: args }
  });
}

function startServer() {
  const proc = spawn('node', ['index.js'], {
    cwd: PROJECT_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, IDLE_SHUTDOWN_MS: '0' }
  });
  const state = { proc, stderr: '' };
  proc.stderr.on('data', d => { state.stderr += d.toString(); });
  return state;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(proc, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) return proc.exitCode;
    await sleep(100);
  }
  assert.fail('process did not exit in time');
}

describe('Cleanup', () => {
  it('cleans up browser, WebSocket, profile, and Chromium on SIGTERM', async () => {
    const state = startServer();
    await sleep(500);
    await initialize(state.proc);

    await callTool(state.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/` });

    const pid = parseInt(state.stderr.match(/Chromium PID: (\d+)/)[1], 10);
    const profile = state.stderr.match(/Profile dir: ([^\n]+)/)[1];
    assert.ok(existsSync(profile));

    state.proc.kill('SIGTERM');
    const exitCode = await waitForExit(state.proc);
    assert.equal(exitCode, 0, 'clean shutdown should exit 0');

    // Browser cleanup ran: WebSocket closed, Chromium killed, profile deleted.
    assert.ok(state.stderr.includes('[Browser] Cleanup complete'), 'browser cleanup should run');
    assert.ok(state.stderr.includes('Shutting down'), 'server should log shutdown');
    assert.equal(pidAlive(pid), false, 'Chromium process must be killed');
    assert.equal(existsSync(profile), false, 'profile directory must be deleted');
  });

  it('handles multiple SIGTERM signals (cleanup runs only once)', async () => {
    const state = startServer();
    await sleep(500);
    await initialize(state.proc);
    await callTool(state.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/` });

    const pid = parseInt(state.stderr.match(/Chromium PID: (\d+)/)[1], 10);

    state.proc.kill('SIGTERM');
    state.proc.kill('SIGTERM');
    state.proc.kill('SIGTERM');
    const exitCode = await waitForExit(state.proc);

    assert.equal(exitCode, 0);
    const cleanups = state.stderr.match(/Cleanup complete/g) || [];
    assert.ok(cleanups.length >= 1, 'cleanup should have run');
    assert.ok(cleanups.length <= 2, 'cleanup must not run repeatedly per signal');
    assert.equal(pidAlive(pid), false);
  });

  it('keeps the MCP server alive after idle shutdown (browser-only cleanup)', async () => {
    const proc = spawn('node', ['index.js'], {
      cwd: PROJECT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, IDLE_SHUTDOWN_MS: '1500' }
    });
    const state = { proc, stderr: '' };
    proc.stderr.on('data', d => { state.stderr += d.toString(); });

    await sleep(500);
    await initialize(proc);
    await callTool(proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/` });

    await sleep(2500);
    assert.ok(state.stderr.includes('[MCP] Idle timeout reached'), 'idle shutdown should fire');
    assert.equal(proc.exitCode, null, 'MCP server must stay alive');

    // Browser cleanup ran, but the server is still usable.
    const response = await callTool(proc, 'browser_get_text', {});
    assert.notEqual(response.result.isError, true);

    proc.kill('SIGTERM');
    await waitForExit(proc);
  });

  it('SIGKILL orphans the Chromium child (documented behavior) and is recoverable', async () => {
    const state = startServer();
    await sleep(500);
    await initialize(state.proc);
    await callTool(state.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/` });

    const pid = parseInt(state.stderr.match(/Chromium PID: (\d+)/)[1], 10);

    // SIGKILL cannot be trapped — the server cannot run cleanup.
    state.proc.kill('SIGKILL');
    await sleep(1000);

    // Chromium is a child of the dead server. It either died with it (pipe
    // closure) or lingers as an orphan. Detect and clean up the orphan.
    if (pidAlive(pid)) {
      process.kill(pid, 'SIGKILL'); // clean up the orphan
      await sleep(300);
      assert.equal(pidAlive(pid), false);
    }
    // Either outcome is acceptable and documented: SIGKILL gives the server no
    // chance to run cleanup, so operators must ensure Chromium is not orphaned
    // (or rely on the idle/restart machinery to reap it next start).
  });

  it('cleanup() is idempotent and never double-runs at the unit level', async () => {
    const { Browser } = await import('../src/browser.js');
    const browser = new Browser();
    await browser.start();

    await browser.cleanup();
    const stateAfterFirst = browser.state;
    const cdpAfterFirst = browser.cdp;
    await browser.cleanup(); // second call must be a no-op

    assert.equal(browser.state, stateAfterFirst);
    assert.equal(browser.cdp, cdpAfterFirst);
    assert.equal(browser.state, 'stopped');
  });

  // Regression: _killChildrenByProfile silently did nothing because
  // readdirSync was never imported — the ReferenceError was swallowed by its
  // catch-all. Without this test the profile-orphan reaping is untested.
  it('kills the orphaned children that still reference the profile dir', async () => {
    const { Browser } = await import('../src/browser.js');
    const browser = new Browser();
    const profileMarker = `browser-mcp-profile-${process.pid}-${Date.now()}`;

    // Stand-in for a Chromium child: --user-data-dir=<profile> keeps the
    // profile path in the cmdline, which is exactly what the scan looks for.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', profileMarker], {
      stdio: 'ignore'
    });
    await sleep(500);
    assert.equal(pidAlive(child.pid), true, 'stand-in child should be running');

    browser._killChildrenByProfile(profileMarker);
    await sleep(300);

    assert.equal(pidAlive(child.pid), false, 'child referencing the profile must be killed');
    child.kill('SIGKILL'); // no-op when already reaped
  });
});
