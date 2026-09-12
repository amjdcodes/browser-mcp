import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
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
      clientInfo: { name: 'parallel-test', version: '1.0.0' }
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

function startServer(outputDir) {
  const proc = spawn('node', ['index.js'], {
    cwd: PROJECT_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, IDLE_SHUTDOWN_MS: '0', OUTPUT_DIR: outputDir }
  });
  const state = { proc, stderr: '', outputDir };
  proc.stderr.on('data', d => { state.stderr += d.toString(); });
  return state;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseFirst(state, regex) {
  const m = state.stderr.match(regex);
  return m ? m[1] : null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Parallel MCP server instances', () => {
  const instances = [];

  afterEach(async () => {
    for (const inst of instances) {
      if (inst?.proc && inst.proc.exitCode === null) {
        inst.proc.kill('SIGTERM');
      }
    }
    await sleep(700);
    instances.length = 0;
  });

  it('runs two instances independently (own Chromium, port, profile, output dir)', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'mcp-out-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'mcp-out-b-'));
    const a = startServer(dirA);
    const b = startServer(dirB);
    instances.push(a, b);

    await sleep(500);
    await initialize(a.proc);
    await initialize(b.proc);

    // Navigate each instance to a DIFFERENT page.
    const navA = await callTool(a.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/` });
    const navB = await callTool(b.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/page2.html` });
    assert.notEqual(navA.result.isError, true);
    assert.notEqual(navB.result.isError, true);

    // Each instance spawned its own Chromium with its own PID and port.
    const pidA = parseInt(parseFirst(a, /Chromium PID: (\d+)/), 10);
    const pidB = parseInt(parseFirst(b, /Chromium PID: (\d+)/), 10);
    const portA = parseFirst(a, /CDP port: (\d+)/);
    const portB = parseFirst(b, /CDP port: (\d+)/);
    const profileA = parseFirst(a, /Profile dir: ([^\n]+)/);
    const profileB = parseFirst(b, /Profile dir: ([^\n]+)/);

    assert.ok(pidA && pidB, 'both instances should have spawned Chromium');
    assert.notEqual(pidA, pidB, 'instances must not share a Chromium process');
    assert.notEqual(portA, portB, 'instances must not share a CDP port');
    assert.notEqual(profileA, profileB, 'instances must not share a profile directory');

    // Independent page state.
    const textA = await callTool(a.proc, 'browser_get_text', { selector: '#page2-text', timeout_ms: 3000 });
    const textB = await callTool(b.proc, 'browser_get_text', { selector: '#page2-text' });
    // A is on the test page (no #page2-text), B is on page2.
    assert.equal(textA.result.isError, true, 'instance A must still be on the test page');
    assert.notEqual(textB.result.isError, true, 'instance B must be on page2');

    // Independent screenshots into each instance's own OUTPUT_DIR.
    const shotA = await callTool(a.proc, 'browser_screenshot', { filename: 'a.jpg', format: 'jpeg' });
    const shotB = await callTool(b.proc, 'browser_screenshot', { filename: 'b.jpg', format: 'jpeg' });
    assert.notEqual(shotA.result.isError, true);
    assert.notEqual(shotB.result.isError, true);
    assert.ok(existsSync(join(dirA, 'a.jpg')), 'screenshot A in its own output dir');
    assert.ok(existsSync(join(dirB, 'b.jpg')), 'screenshot B in its own output dir');
  });

  it('shuts down independently (one idle/stopped, the other keeps working)', async () => {
    const a = startServer(mkdtempSync(join(tmpdir(), 'mcp-out-a2-')));
    const b = startServer(mkdtempSync(join(tmpdir(), 'mcp-out-b2-')));
    instances.push(a, b);

    await sleep(500);
    await initialize(a.proc);
    await initialize(b.proc);
    await callTool(a.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/` });
    await callTool(b.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/` });

    const pidA = parseInt(parseFirst(a, /Chromium PID: (\d+)/), 10);
    const pidB = parseInt(parseFirst(b, /Chromium PID: (\d+)/), 10);
    assert.ok(pidA && pidB);

    // Stop instance A (SIGTERM → clean browser cleanup). B must be unaffected.
    a.proc.kill('SIGTERM');
    await sleep(1500);
    assert.equal(pidAlive(pidA), false, 'instance A Chromium must be stopped');
    assert.ok(pidAlive(pidB), 'instance B Chromium must keep running');

    const navB2 = await callTool(b.proc, 'browser_navigate', { url: `http://127.0.0.1:${fixturePort}/page2.html` });
    assert.notEqual(navB2.result.isError, true, 'instance B must still operate');

    // Now stop B.
    b.proc.kill('SIGTERM');
    await sleep(1500);
    assert.equal(pidAlive(pidB), false, 'instance B Chromium must be stopped');
  });
});
