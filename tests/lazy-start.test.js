import { spawn } from 'node:child_process';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const PROJECT_DIR = '/root/browser-mcp';

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
      clientInfo: { name: 'lazy-test', version: '1.0.0' }
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
    env: { ...process.env, IDLE_SHUTDOWN_MS: '0' } // disable idle for these tests
  });
  const state = { proc, stderr: '' };
  proc.stderr.on('data', d => { state.stderr += d.toString(); });
  return state;
}

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

describe('Lazy start', () => {
  let state;

  afterEach(async () => {
    if (state?.proc) {
      state.proc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      state = null;
    }
  });

  it('does not start the browser on MCP server launch', async () => {
    state = startServer();
    await new Promise(resolve => setTimeout(resolve, 800));
    await initialize(state.proc);

    // No Chromium lifecycle activity at all.
    assert.ok(!state.stderr.includes('[Browser] Found Chromium'), 'Chromium should not be found yet');
    assert.ok(!state.stderr.includes('[Browser] Profile dir'), 'no profile directory should be created');
    assert.ok(!state.stderr.includes('Ready on port'), 'no CDP port should be allocated');
    assert.ok(!state.stderr.includes('[MCP] Starting browser'), 'browser should not start');
  });

  it('starts the browser on the first tool call (stopped → starting → ready)', async () => {
    state = startServer();
    await new Promise(resolve => setTimeout(resolve, 500));
    await initialize(state.proc);

    const response = await callTool(state.proc, 'browser_navigate', { url: 'about:blank' });
    assert.ok(response.result);
    assert.notEqual(response.result.isError, true);

    assert.ok(state.stderr.includes('[MCP] Starting browser'), 'first tool call should start the browser');
    assert.ok(state.stderr.includes('[Browser] Found Chromium'), 'Chromium should be located');
    assert.ok(state.stderr.includes('[Browser] Profile dir'), 'a profile directory should be created');
    assert.ok(state.stderr.includes('Ready on port'), 'a CDP port should be allocated');
    assert.equal(countOccurrences(state.stderr, '[MCP] Starting browser'), 1, 'browser started exactly once');
  });

  it('stays ready for subsequent calls (no restarts, same profile/port)', async () => {
    state = startServer();
    await new Promise(resolve => setTimeout(resolve, 500));
    await initialize(state.proc);

    await callTool(state.proc, 'browser_navigate', { url: 'about:blank' });
    await callTool(state.proc, 'browser_get_text', {});
    await callTool(state.proc, 'browser_navigate', { url: 'about:blank' });

    assert.equal(countOccurrences(state.stderr, '[MCP] Starting browser'), 1, 'browser started exactly once');
    assert.equal(countOccurrences(state.stderr, '[Browser] Found Chromium'), 1, 'Chromium located exactly once');
    assert.equal(countOccurrences(state.stderr, 'Ready on port'), 1, 'only one CDP port allocation');

    const profiles = state.stderr.match(/Profile dir: ([^\n]+)/g) || [];
    assert.equal(profiles.length, 1, 'same profile reused across calls');
  });
});
