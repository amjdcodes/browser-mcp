import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, afterEach, before, after } from 'node:test';
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
      } catch {
        // Response already sent or client aborted — ignore.
      }
    }
  });
  // One request per socket: chromium keep-alive sockets must not linger
  // across tests (prevents ERR_HTTP_HEADERS_SENT on teardown).
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

function sendRequest(proc, request, timeoutMs = 45000) {
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
      clientInfo: { name: 'idle-test', version: '1.0.0' }
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

function startServer(env = {}) {
  const proc = spawn('node', ['index.js'], {
    cwd: PROJECT_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  });
  const state = { proc, stderr: '' };
  proc.stderr.on('data', d => { state.stderr += d.toString(); });
  return state;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

describe('Idle shutdown', () => {
  let state;

  afterEach(async () => {
    if (state?.proc) {
      state.proc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      state = null;
    }
  });

  it('shuts the browser down after the idle period and restarts on next call', async () => {
    state = startServer({ IDLE_SHUTDOWN_MS: '2000' });
    await sleep(500);
    await initialize(state.proc);

    await callTool(state.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/` });
    assert.equal(countOccurrences(state.stderr, '[MCP] Starting browser'), 1);

    // Wait past the idle window — the browser must shut down while the MCP
    // server stays alive.
    await sleep(3500);
    assert.ok(state.stderr.includes('[MCP] Idle timeout reached'), 'idle shutdown should have fired');
    assert.equal(state.proc.exitCode, null, 'MCP server must stay alive after idle shutdown');

    // Next tool call restarts the browser transparently.
    const response = await callTool(state.proc, 'browser_get_text', {});
    assert.ok(response.result);
    assert.notEqual(response.result.isError, true);
    assert.equal(countOccurrences(state.stderr, '[MCP] Starting browser'), 2, 'browser restarted on next call');
  });

  it('resets the idle timer on continued activity', async () => {
    state = startServer({ IDLE_SHUTDOWN_MS: '2000' });
    await sleep(500);
    await initialize(state.proc);

    await callTool(state.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/` });

    // Keep poking every ~1s for 4.5s — each call must push the idle deadline.
    for (let i = 0; i < 4; i++) {
      await sleep(1000);
      const response = await callTool(state.proc, 'browser_get_text', { selector: '#english-text' });
      assert.notEqual(response.result.isError, true);
    }
    await sleep(500);

    assert.ok(!state.stderr.includes('[MCP] Idle timeout reached'), 'idle must not fire with activity');
    assert.equal(countOccurrences(state.stderr, '[MCP] Starting browser'), 1, 'browser never shut down');
  });

  it('does not interrupt an in-flight operation (idle shorter than operation)', async () => {
    // #delayed-element-4s appears 4s after page load. Idle is 1000ms — far
    // shorter than the operation — so the wait must complete uninterrupted.
    state = startServer({ IDLE_SHUTDOWN_MS: '1000' });
    await sleep(500);
    await initialize(state.proc);

    await callTool(state.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/` });

    const started = Date.now();
    const response = await callTool(state.proc, 'browser_wait_for', {
      selector: '#delayed-element-4s',
      timeout_ms: 10000
    }, 45000);

    assert.ok(response.result);
    assert.notEqual(response.result.isError, true, `wait_for was interrupted: ${response.result?.content?.[0]?.text}`);
    assert.ok(Date.now() - started >= 1000, 'operation should have outlived the idle window');

    // The browser must NOT have been closed while the operation was in flight.
    assert.ok(!state.stderr.includes('Idle timeout reached, closing browser'),
              'browser must not have been closed during the operation');
  });

  it('IDLE_SHUTDOWN_MS=0 disables idle shutdown entirely', async () => {
    state = startServer({ IDLE_SHUTDOWN_MS: '0' });
    await sleep(500);
    await initialize(state.proc);

    await callTool(state.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/` });
    await sleep(3000);

    assert.ok(!state.stderr.includes('[MCP] Idle timeout reached'), 'idle shutdown must be disabled');
    const response = await callTool(state.proc, 'browser_get_text', {});
    assert.notEqual(response.result.isError, true);
    assert.equal(countOccurrences(state.stderr, '[MCP] Starting browser'), 1);
  });

  it('idle shutdown cleans up the Chromium process and profile', async () => {
    state = startServer({ IDLE_SHUTDOWN_MS: '2000' });
    await sleep(500);
    await initialize(state.proc);

    await callTool(state.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/` });

    // Capture the chromium PID from the server logs.
    const match = state.stderr.match(/Chromium PID: (\d+)/);
    assert.ok(match, 'expected a Chromium PID log');
    const pid = parseInt(match[1], 10);
    const profileMatch = state.stderr.match(/Profile dir: ([^\n]+)/);
    assert.ok(profileMatch);

    // Wait for idle shutdown AND the browser cleanup to complete. Cleanup can
    // take a moment under load (process group kill + profile removal retries),
    // so poll for the completion log instead of using a fixed sleep.
    const deadline = Date.now() + 12000;
    while (
      Date.now() < deadline &&
      !state.stderr.includes('[Browser] Cleanup complete')
    ) {
      await sleep(200);
    }

    assert.ok(state.stderr.includes('[MCP] Idle timeout reached'), 'idle shutdown should fire');
    assert.ok(state.stderr.includes('[Browser] Cleanup complete'), 'browser cleanup should run');

    // Chromium process is gone and the profile directory was removed.
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, 'Chromium process must be killed on idle shutdown');

    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(profileMatch[1]), false, 'profile directory must be removed');
  });
});
