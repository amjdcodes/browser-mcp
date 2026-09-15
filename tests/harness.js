// tests/harness.js
// ---------------------------------------------------------------------------
// Shared test infrastructure for the integration suites: a local fixture HTTP
// server, an MCP server child process speaking newline-delimited JSON-RPC over
// stdio, and small helpers to call tools and assert on results.
//
// Responses are reassembled across stdout chunks, so large payloads (inline
// base64 screenshots) resolve correctly.
//
// Not a test file itself (does not match the `*.test.js` glob).
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');
const SERVER_CWD = join(__dirname, '..');

let nextId = 1000;

/** Start a local HTTP server that serves files from fixtures/. */
export function startFixtureServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const filePath = join(fixturesDir, req.url === '/' ? 'test-page.html' : req.url);
      try {
        const content = readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

/**
 * Spawn the MCP server. `ENABLE_EVAL_JS` is removed from the inherited
 * environment so the default (disabled) is exercised unless a test passes it
 * explicitly via extraEnv.
 */
export function startMcpServer(extraEnv = {}) {
  const env = { ...process.env };
  delete env.ENABLE_EVAL_JS;
  Object.assign(env, extraEnv);

  const proc = spawn('node', ['index.js'], {
    cwd: SERVER_CWD,
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  });

  const state = { proc, stderr: '', buffer: '', pending: new Map() };

  // Reassemble newline-delimited JSON-RPC across stdout chunks.
  proc.stdout.on('data', (data) => {
    state.buffer += data.toString();
    let idx;
    while ((idx = state.buffer.indexOf('\n')) !== -1) {
      const line = state.buffer.slice(0, idx).trim();
      state.buffer = state.buffer.slice(idx + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      if (message.id !== undefined && state.pending.has(message.id)) {
        const { resolve, timer } = state.pending.get(message.id);
        state.pending.delete(message.id);
        clearTimeout(timer);
        resolve(message);
      }
    }
  });

  proc.stderr.on('data', (d) => { state.stderr += d.toString(); });
  return state;
}

export async function stopServer(state) {
  if (!state?.proc) return;
  state.proc.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function send(state, request, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(request.id);
      reject(new Error(`Timeout waiting for response (id ${request.id})`));
    }, timeoutMs);

    state.pending.set(request.id, { resolve, timer });
    state.proc.stdin.write(JSON.stringify(request) + '\n');
  });
}

export async function initializeServer(state, name = 'harness') {
  await send(state, {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name, version: '1.0.0' }
    }
  });

  state.proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  }) + '\n');

  await new Promise((resolve) => setTimeout(resolve, 200));
}

export function resultText(response) {
  return response?.result?.content?.[0]?.text;
}

export function parseResult(response) {
  return JSON.parse(resultText(response));
}

export function assertSuccess(response) {
  assert.ok(response?.result, 'expected a result');
  assert.notEqual(
    response.result.isError,
    true,
    `expected success, got error: ${resultText(response)}`
  );
  return parseResult(response);
}

/** Make a `callTool(name, args)` bound to a running server. */
export function makeCallTool(state) {
  return (name, args = {}, timeoutMs = 30000) => send(state, {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'tools/call',
    params: { name, arguments: args }
  }, timeoutMs);
}

/** Convenience: navigate to the shared fixture page. */
export async function navigateToTestPage(call, port) {
  assertSuccess(await call('browser_navigate', { url: `http://127.0.0.1:${port}/` }));
}

/** Read text of a selector (asserts success). */
export async function getText(call, selector) {
  const response = await call('browser_get_text', { selector });
  return assertSuccess(response).text;
}
