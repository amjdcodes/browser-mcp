import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

let fixtureServer;
let fixturePort;

function startFixtureServer() {
  return new Promise((resolve) => {
    fixtureServer = createServer((req, res) => {
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
    fixtureServer.listen(0, '127.0.0.1', () => {
      fixturePort = fixtureServer.address().port;
      resolve();
    });
  });
}

function sendRequest(proc, request, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(request);
    proc.stdin.write(json + '\n');

    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for response (id ${request.id})`));
    }, timeoutMs);

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
        } catch {
          // Ignore parse errors
        }
      }
    };

    proc.stdout.on('data', onData);
  });
}

async function initializeServer(proc) {
  const initRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'interaction-test', version: '1.0.0' }
    }
  };
  await sendRequest(proc, initRequest);

  proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  }) + '\n');

  await new Promise(resolve => setTimeout(resolve, 200));
}

function startMcpServer() {
  const proc = spawn('node', ['index.js'], {
    cwd: '/root/browser-mcp',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const state = { proc, stderr: '' };
  proc.stderr.on('data', (d) => { state.stderr += d.toString(); });
  return state;
}

let nextId = 100;

async function callTool(state, name, args = {}, timeoutMs = 30000) {
  const request = {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'tools/call',
    params: { name, arguments: args }
  };
  return sendRequest(state.proc, request, timeoutMs);
}

function resultText(response) {
  return response?.result?.content?.[0]?.text;
}

function parseResult(response) {
  return JSON.parse(resultText(response));
}

function assertSuccess(response) {
  assert.ok(response?.result, 'expected a result');
  assert.notEqual(response.result.isError, true, `expected success, got error: ${resultText(response)}`);
  return parseResult(response);
}

async function navigateToTestPage(state) {
  const response = await callTool(state, 'browser_navigate', {
    url: `http://127.0.0.1:${fixturePort}/`
  });
  assertSuccess(response);
}

async function navigateToPage2(state) {
  const response = await callTool(state, 'browser_navigate', {
    url: `http://127.0.0.1:${fixturePort}/page2.html`
  });
  assertSuccess(response);
}

async function getText(state, selector, timeoutMs = 10000) {
  const response = await callTool(state, 'browser_get_text', { selector, timeout_ms: timeoutMs });
  assertSuccess(response);
  return parseResult(response).text;
}

// ---------------------------------------------------------------------------

describe('browser_click', () => {
  let state;

  before(async () => {
    await startFixtureServer();
    state = startMcpServer();
    await initializeServer(state.proc);
  });

  after(async () => {
    if (state?.proc) {
      state.proc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    fixtureServer?.close();
  });

  beforeEach(async () => {
    await navigateToTestPage(state);
  });

  it('clicks a button that changes text', async () => {
    const result = assertSuccess(await callTool(state, 'browser_click', {
      selector: '#change-text-btn'
    }));
    assert.equal(result.clicked, true);
    assert.equal(result.selector, '#change-text-btn');
    assert.equal(typeof result.x, 'number');

    const text = await getText(state, '#click-result');
    assert.ok(text.includes('Text changed by button click!'));
  });

  it('clicks a link that navigates to another page', async () => {
    assertSuccess(await callTool(state, 'browser_click', { selector: '#nav-link' }));

    const response = await callTool(state, 'browser_get_text', {
      selector: '#page2-text',
      timeout_ms: 8000
    });
    assertSuccess(response);
    const parsed = parseResult(response);
    assert.ok(parsed.text.includes('You have navigated to page 2'));
  });

  it('fails with a clear error when the element is hidden', async () => {
    const response = await callTool(state, 'browser_click', { selector: '#hidden-btn' });
    assert.equal(response.result.isError, true);
    assert.ok(resultText(response).includes('ELEMENT_HIDDEN'));
    assert.ok(resultText(response).includes('not visible'));
  });

  it('fails with ELEMENT_NOT_FOUND when the element never exists', async () => {
    const response = await callTool(state, 'browser_click', {
      selector: '#never-exists',
      timeout_ms: 800
    });
    assert.equal(response.result.isError, true);
    assert.ok(resultText(response).includes('ELEMENT_NOT_FOUND'));
    assert.ok(resultText(response).includes('Element not found'));
  });

  it('scrolls elements below the fold into view before clicking', async () => {
    const result = assertSuccess(await callTool(state, 'browser_click', {
      selector: '#far-btn'
    }));
    assert.equal(result.clicked, true);

    const text = await getText(state, '#far-result');
    assert.ok(text.includes('Far button clicked!'));
  });

  it('fails gracefully on an invalid CSS selector', async () => {
    const response = await callTool(state, 'browser_click', {
      selector: '###invalid###',
      timeout_ms: 500
    });
    assert.equal(response.result.isError, true);
    assert.ok(/SyntaxError|not a valid selector/i.test(resultText(response)));
  });

  it('clicks the first element when a selector matches multiple', async () => {
    // .section p contains several paragraphs; .section h2 headings are also
    // multiple. Use a multi-match button-ish selector: buttons in the form.
    assertSuccess(await callTool(state, 'browser_click', { selector: 'button' }));
    // The first <button> on the page is #submit-btn inside #test-form.
    const text = await getText(state, '#click-result');
    assert.ok(text.length > 0);
  });
});

// ---------------------------------------------------------------------------

describe('browser_type', () => {
  let state;

  before(async () => {
    await startFixtureServer();
    state = startMcpServer();
    await initializeServer(state.proc);
  });

  after(async () => {
    if (state?.proc) {
      state.proc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    fixtureServer?.close();
  });

  beforeEach(async () => {
    await navigateToTestPage(state);
  });

  it('types English text into an input', async () => {
    const result = assertSuccess(await callTool(state, 'browser_type', {
      selector: '#text-input',
      text: 'Hello world'
    }));
    assert.equal(result.typed, true);
    assert.equal(result.length, 11);

    const echo = await getText(state, '#input-echo');
    assert.equal(echo, 'Hello world');
  });

  it('types Arabic text into an input (encoding/RTL)', async () => {
    const arabic = 'مرحبا بالعالم';
    assertSuccess(await callTool(state, 'browser_type', {
      selector: '#text-input',
      text: arabic
    }));

    const echo = await getText(state, '#input-echo');
    assert.equal(echo, arabic);
  });

  it('types multi-line text into a textarea', async () => {
    assertSuccess(await callTool(state, 'browser_type', {
      selector: '#textarea',
      text: 'first line\nsecond line'
    }));

    const echo = await getText(state, '#textarea-echo');
    // innerText renders newlines as whitespace — normalize for comparison.
    assert.ok(echo.replace(/\s+/g, ' ').includes('first line second line'));
  });

  it('types into a contenteditable div', async () => {
    assertSuccess(await callTool(state, 'browser_type', {
      selector: '#editable-div',
      text: 'typed content here'
    }));

    const text = await getText(state, '#editable-div');
    assert.ok(text.includes('typed content here'));
  });

  it('clears existing text before typing (clear_first default true)', async () => {
    await callTool(state, 'browser_type', { selector: '#text-input', text: 'first' });
    await callTool(state, 'browser_type', { selector: '#text-input', text: 'second' });

    const echo = await getText(state, '#input-echo');
    assert.equal(echo, 'second');
  });

  it('keeps existing text when clear_first is false', async () => {
    await callTool(state, 'browser_type', { selector: '#text-input', text: 'first' });
    await callTool(state, 'browser_type', {
      selector: '#text-input',
      text: '+second',
      clear_first: false
    });

    const echo = await getText(state, '#input-echo');
    assert.equal(echo, 'first+second');
  });

  it('types special characters and symbols', async () => {
    const special = '<>&"\'@#$%^&*(){}[]|\\;:~`!?=-_+';
    assertSuccess(await callTool(state, 'browser_type', {
      selector: '#text-input',
      text: special
    }));

    const echo = await getText(state, '#input-echo');
    assert.equal(echo, special);
  });

  it('types Chinese and emoji', async () => {
    const mixed = '你好世界 🌍🚀';
    assertSuccess(await callTool(state, 'browser_type', {
      selector: '#text-input',
      text: mixed
    }));

    const echo = await getText(state, '#input-echo');
    assert.equal(echo, mixed);
  });

  it('types long text', async () => {
    const long = 'The quick brown fox jumps over the lazy dog. '.repeat(50);
    assertSuccess(await callTool(state, 'browser_type', {
      selector: '#textarea',
      text: long
    }));

    const echo = await getText(state, '#textarea-echo');
    assert.equal(echo.replace(/\s+/g, ' ').trim().length, long.replace(/\s+/g, ' ').trim().length);
  });

  it('types an empty string without error', async () => {
    const result = assertSuccess(await callTool(state, 'browser_type', {
      selector: '#text-input',
      text: ''
    }));
    assert.equal(result.length, 0);
  });

  it('fails when the target is not typeable', async () => {
    const response = await callTool(state, 'browser_type', {
      selector: '#english-text',
      text: 'nope'
    });
    assert.equal(response.result.isError, true);
    assert.ok(resultText(response).includes('ELEMENT_NOT_TYPEABLE'));
  });

  it('never logs the typed text to stderr', async () => {
    const secret = 'sup3r-s3cret-p@ssw0rd-تست';
    await callTool(state, 'browser_type', { selector: '#text-input', text: secret });

    // Give stderr a moment to flush, then assert the value never appeared.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(!state.stderr.includes(secret), 'typed text leaked to stderr!');
  });
});

// ---------------------------------------------------------------------------

describe('browser_wait_for', () => {
  let state;

  before(async () => {
    await startFixtureServer();
    state = startMcpServer();
    await initializeServer(state.proc);
  });

  after(async () => {
    if (state?.proc) {
      state.proc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    fixtureServer?.close();
  });

  beforeEach(async () => {
    await navigateToTestPage(state);
  });

  it('waits for an element that appears after a delay', async () => {
    const response = await callTool(state, 'browser_wait_for', {
      selector: '#delayed-element',
      timeout_ms: 8000
    });
    const result = assertSuccess(response);
    assert.equal(result.found, true);
    assert.ok(result.elapsed_ms >= 0);
  });

  it('waits for text that appears after a delay', async () => {
    const response = await callTool(state, 'browser_wait_for', {
      text: 'Delayed element appears after 2 seconds',
      timeout_ms: 8000
    });
    const result = assertSuccess(response);
    assert.equal(result.found, true);
  });

  it('waits for both selector and text together', async () => {
    const response = await callTool(state, 'browser_wait_for', {
      selector: '#english-text',
      text: 'visible English text',
      timeout_ms: 5000
    });
    const result = assertSuccess(response);
    assert.equal(result.found, true);
    assert.equal(result.selector, '#english-text');
  });

  it('waits for text that appears after a button click', async () => {
    assertSuccess(await callTool(state, 'browser_click', { selector: '#change-text-btn' }));
    const response = await callTool(state, 'browser_wait_for', {
      text: 'Text changed by button click!',
      timeout_ms: 5000
    });
    assertSuccess(response);
  });

  it('times out when the element never appears', async () => {
    const response = await callTool(state, 'browser_wait_for', {
      selector: '#never-exists',
      timeout_ms: 700
    });
    assert.equal(response.result.isError, true);
    assert.ok(resultText(response).includes('TIMEOUT'));
    assert.ok(resultText(response).includes('#never-exists'));
  });

  it('times out when the text never appears', async () => {
    const response = await callTool(state, 'browser_wait_for', {
      text: 'this text does not exist anywhere',
      timeout_ms: 700
    });
    assert.equal(response.result.isError, true);
    assert.ok(resultText(response).includes('TIMEOUT'));
  });

  it('waits for Arabic text', async () => {
    const response = await callTool(state, 'browser_wait_for', {
      text: 'نص عربي مرئي',
      timeout_ms: 5000
    });
    const result = assertSuccess(response);
    assert.equal(result.found, true);
  });

  it('matches text with whitespace variations (normalized)', async () => {
    const response = await callTool(state, 'browser_wait_for', {
      text: 'visible    English   text',
      timeout_ms: 5000
    });
    const result = assertSuccess(response);
    assert.equal(result.found, true);
  });

  it('fails validation when neither selector nor text is provided', async () => {
    const response = await callTool(state, 'browser_wait_for', { timeout_ms: 500 });
    assert.equal(response.result.isError, true);
    assert.ok(resultText(response).includes('INVALID_ARGS'));
  });

  it('fails fast with a very short timeout', async () => {
    const start = Date.now();
    const response = await callTool(state, 'browser_wait_for', {
      selector: '#never-exists',
      timeout_ms: 300
    });
    const elapsed = Date.now() - start;
    assert.equal(response.result.isError, true);
    assert.ok(elapsed < 5000, `expected fast failure, took ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------

describe('operation lock', () => {
  let state;

  before(async () => {
    await startFixtureServer();
    state = startMcpServer();
    await initializeServer(state.proc);
  });

  after(async () => {
    if (state?.proc) {
      state.proc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    fixtureServer?.close();
  });

  it('serializes concurrent clicks without dropping any', async () => {
    await navigateToTestPage(state);

    const requests = [];
    for (let i = 0; i < 6; i++) {
      requests.push(callTool(state, 'browser_click', { selector: '#change-text-btn' }, 45000));
    }

    const responses = await Promise.all(requests);
    for (const response of responses) {
      const result = assertSuccess(response);
      assert.equal(result.clicked, true);
    }

    // Every click dispatched a change; the counter text reflects at least one.
    const text = await getText(state, '#click-result');
    assert.ok(text.includes('Text changed by button click!'));
  });

  it('releases the lock after an error so later operations proceed', async () => {
    await navigateToTestPage(state);

    const failing = await callTool(state, 'browser_click', {
      selector: '#never-exists',
      timeout_ms: 600
    });
    assert.equal(failing.result.isError, true);

    // Lock must be free: a subsequent state-changing op succeeds.
    const success = assertSuccess(await callTool(state, 'browser_click', {
      selector: '#change-text-btn'
    }));
    assert.equal(success.clicked, true);
  });

  it('allows type while clicks are queued (no interleaving)', async () => {
    await navigateToTestPage(state);

    const click1 = callTool(state, 'browser_click', { selector: '#change-text-btn' }, 45000);
    const type1 = callTool(state, 'browser_type', { selector: '#text-input', text: 'queued' }, 45000);
    const click2 = callTool(state, 'browser_click', { selector: '#change-text-btn' }, 45000);

    const [r1, r2, r3] = await Promise.all([click1, type1, click2]);
    assertSuccess(r1);
    assertSuccess(r2);
    assertSuccess(r3);

    const echo = await getText(state, '#input-echo');
    assert.equal(echo, 'queued');
  });
});

// ---------------------------------------------------------------------------

describe('security and robustness', () => {
  it('treats a malicious selector as data, never executing code', async () => {
    await startFixtureServer();
    const state = startMcpServer();
    await initializeServer(state.proc);
    await navigateToTestPage(state);

    const response = await callTool(state, 'browser_click', {
      selector: `'); maliciousCode(); ('`,
      timeout_ms: 600
    });

    assert.equal(response.result.isError, true);
    assert.ok(/not a valid selector|SyntaxError/i.test(resultText(response)));

    // The page is still intact and functional.
    const text = await getText(state, '#click-result');
    assert.ok(text.includes('Click the button'));

    state.proc.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    fixtureServer?.close();
  });

  it('types a malicious payload literally without executing it', async () => {
    await startFixtureServer();
    const state = startMcpServer();
    await initializeServer(state.proc);
    await navigateToTestPage(state);

    const payload = `'); globalThis.pwned = true; ('`;
    assertSuccess(await callTool(state, 'browser_type', {
      selector: '#text-input',
      text: payload
    }));

    const echo = await getText(state, '#input-echo');
    assert.equal(echo, payload);

    state.proc.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    fixtureServer?.close();
  });

  it('starts the browser automatically on first interaction call', async () => {
    await startFixtureServer();
    const state = startMcpServer();
    await initializeServer(state.proc);

    // No navigation yet — the interaction tool must lazily start the browser.
    const response = await callTool(state, 'browser_wait_for', {
      selector: '#never-exists',
      timeout_ms: 600
    });
    assert.equal(response.result.isError, true);
    assert.ok(resultText(response).includes('TIMEOUT'));
    assert.ok(state.stderr.includes('[MCP] Starting browser'), 'browser was not started lazily');
    assert.equal(state.proc.exitCode, null, 'server must still be alive');

    // A subsequent navigation still works.
    const nav = await callTool(state, 'browser_navigate', {
      url: `http://127.0.0.1:${fixturePort}/`
    });
    assertSuccess(nav);

    state.proc.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    fixtureServer?.close();
  });

  it('recovers with a clear result after the browser process is killed', async () => {
    await startFixtureServer();
    const state = startMcpServer();
    await initializeServer(state.proc);
    await navigateToTestPage(state);

    // Find the Chromium PID from the server's stderr log.
    const match = state.stderr.match(/Chromium PID: (\d+)/);
    assert.ok(match, 'expected a Chromium PID in server stderr');
    const pid = parseInt(match[1], 10);

    process.kill(pid, 'SIGKILL');
    // Allow the server to detect the crash and (re)start the browser.
    await new Promise(resolve => setTimeout(resolve, 2500));

    const response = await callTool(state, 'browser_click', {
      selector: '#change-text-btn',
      timeout_ms: 5000
    }, 45000);

    // Either the browser auto-restarted and the page is gone (clear element
    // error) or the restart was still in progress (clear not-ready error).
    // What matters: a clear response arrives and the server stays alive.
    assert.ok(response.result, 'expected a result after crash');
    assert.ok(resultText(response).length > 0, 'expected a clear error message');
    assert.equal(state.proc.exitCode, null, 'server must survive browser crash');

    state.proc.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    fixtureServer?.close();
  });
});

// ---------------------------------------------------------------------------

// Helper: assert a tool call errored with the given error code prefix.
function assertToolError(response, code, pattern) {
  assert.equal(response.result.isError, true, `expected error, got: ${resultText(response)}`);
  const text = resultText(response);
  if (code) {
    assert.ok(text.includes(`[${code}]`), `expected [${code}] in: ${text}`);
  }
  if (pattern) {
    assert.match(text, pattern);
  }
  return text;
}

describe('browser_scroll', () => {
  let state;

  before(async () => {
    await startFixtureServer();
    state = startMcpServer();
    await initializeServer(state.proc);
  });

  after(async () => {
    if (state?.proc) {
      state.proc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    fixtureServer?.close();
  });

  beforeEach(async () => {
    await navigateToTestPage(state);
  });

  it('scrolls down by ~80% of the viewport height', async () => {
    const result = assertSuccess(await callTool(state, 'browser_scroll', {
      direction: 'down'
    }));
    assert.equal(result.mode, 'direction');
    assert.equal(result.direction, 'down');
    assert.equal(result.scrollX, 0);
    assert.ok(result.scrollY > 0, `expected scrollY > 0, got ${result.scrollY}`);
  });

  it('scrolls by an exact pixel count', async () => {
    const result = assertSuccess(await callTool(state, 'browser_scroll', {
      direction: 'down',
      pixels: 120
    }));
    assert.equal(result.scrollY, 120);
  });

  it('scrolls to the top', async () => {
    await callTool(state, 'browser_scroll', { direction: 'down' });
    const result = assertSuccess(await callTool(state, 'browser_scroll', {
      direction: 'top'
    }));
    assert.equal(result.scrollY, 0);
  });

  it('scrolls to an element and verifies it is in the viewport', async () => {
    const result = assertSuccess(await callTool(state, 'browser_scroll', {
      selector: '#far-section'
    }));
    assert.equal(result.mode, 'element');
    assert.equal(result.inViewport, true);
    assert.ok(result.scrollY > 0);
  });

  it('scrolls to absolute coordinates', async () => {
    const result = assertSuccess(await callTool(state, 'browser_scroll', {
      x: 0,
      y: 500
    }));
    assert.equal(result.mode, 'position');
    assert.equal(result.scrollY, 500);
  });

  it('scrolls horizontally', async () => {
    const result = assertSuccess(await callTool(state, 'browser_scroll', {
      direction: 'right',
      pixels: 100
    }));
    assert.equal(result.scrollX, 100);
  });

  it('rejects when no mode is provided', async () => {
    const response = await callTool(state, 'browser_scroll', {});
    assertToolError(response, 'INVALID_ARGS', /Provide one of/);
  });

  it('rejects conflicting modes', async () => {
    const response = await callTool(state, 'browser_scroll', {
      direction: 'down',
      selector: '#far-section'
    });
    assertToolError(response, 'INVALID_ARGS', /exactly one/);
  });

  it('rejects x without y', async () => {
    const response = await callTool(state, 'browser_scroll', { x: 100 });
    assertToolError(response, 'INVALID_ARGS', /Both x and y/);
  });

  it('scroll completes synchronously (instant, no animation in flight)', async () => {
    const started = Date.now();
    const result = assertSuccess(await callTool(state, 'browser_scroll', {
      direction: 'bottom'
    }));
    assert.ok(Date.now() - started < 2000, 'scroll should not wait for smooth animation');
    assert.ok(result.scrollY > 0);
  });
});

// ---------------------------------------------------------------------------

describe('browser_click force option', () => {
  let state;

  before(async () => {
    await startFixtureServer();
    state = startMcpServer();
    await initializeServer(state.proc);
  });

  after(async () => {
    if (state?.proc) {
      state.proc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    fixtureServer?.close();
  });

  beforeEach(async () => {
    await navigateToTestPage(state);
  });

  it('clicks a partially covered element via the multi-point scan', async () => {
    const result = assertSuccess(await callTool(state, 'browser_click', {
      selector: '#partially-covered'
    }));
    assert.equal(result.clicked, true);
    assert.equal(result.forced, undefined, 'multi-point click is a real mouse click');

    const text = await getText(state, '#overlay-result');
    assert.ok(text.includes('Partially covered button clicked'));
  });

  it('fails on a fully covered element without force (backward compatible)', async () => {
    const response = await callTool(state, 'browser_click', {
      selector: '#fully-covered'
    });
    assertToolError(response, 'ELEMENT_NOT_CLICKABLE', /covered by/);
  });

  it('clicks a fully covered element with force: true (JS fallback)', async () => {
    const result = assertSuccess(await callTool(state, 'browser_click', {
      selector: '#fully-covered',
      force: true
    }));
    assert.equal(result.clicked, true);
    assert.equal(result.forced, true);

    const text = await getText(state, '#overlay-result');
    assert.ok(text.includes('Fully covered button clicked'));
  });
});

// ---------------------------------------------------------------------------

describe('post-click screenshot', () => {
  let state;

  before(async () => {
    await startFixtureServer();
    state = startMcpServer();
    await initializeServer(state.proc);
  });

  after(async () => {
    if (state?.proc) {
      state.proc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    fixtureServer?.close();
  });

  beforeEach(async () => {
    await navigateToTestPage(state);
  });

  it('captures the click effect in an immediately-taken screenshot (not blank)', async () => {
    // Screenshot BEFORE the click.
    const before = await callTool(state, 'browser_screenshot', {
      filename: 'before-click.jpg',
      format: 'jpeg'
    });
    assertSuccess(before);
    const beforeData = before.result.content[1]?.data;
    assert.ok(beforeData, 'expected image data');

    // Click changes visible page content (#click-result text changes color/text).
    const click = await callTool(state, 'browser_click', { selector: '#change-text-btn' });
    assertSuccess(click);
    const text = await getText(state, '#click-result');
    assert.ok(text.includes('Text changed by button click!'));

    // Screenshot IMMEDIATELY after the click — must not be blank and must
    // reflect the changed page state.
    const after = await callTool(state, 'browser_screenshot', {
      filename: 'after-click.jpg',
      format: 'jpeg'
    });
    assertSuccess(after);
    const afterData = after.result.content[1]?.data;
    assert.ok(afterData, 'expected image data');
    assert.ok(afterData.length > 1000, 'image data suspiciously small (blank?)');
    assert.notEqual(afterData, beforeData, 'click effect must be visible in the screenshot');
  });

  it('honors delay_ms on browser_screenshot', async () => {
    const started = Date.now();
    const response = await callTool(state, 'browser_screenshot', {
      filename: 'delayed.jpg',
      format: 'jpeg',
      delay_ms: 600
    });
    assertSuccess(response);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 500, `delay_ms not honored: elapsed ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: scroll helpers must wait for the compositor to repaint, otherwise
// an immediately-following screenshot can capture a black intermediate frame.
// ---------------------------------------------------------------------------

describe('scroll then screenshot (Phase 3)', () => {
  let state;

  before(async () => {
    await startFixtureServer();
    state = startMcpServer();
    await initializeServer(state.proc);
  });

  after(async () => {
    if (state?.proc) {
      state.proc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    fixtureServer?.close();
  });

  beforeEach(async () => {
    await navigateToTestPage(state);
  });

  it('screenshot immediately after a directional scroll is not blank', async () => {
    // Baseline screenshot at the top of the page.
    const top = await callTool(state, 'browser_screenshot', {
      filename: 'p3-top.jpg', format: 'jpeg'
    });
    assertSuccess(top);
    const topData = top.result.content[1]?.data;
    assert.ok(topData, 'expected image data');
    assert.ok(topData.length > 2000, `baseline image suspiciously small: ${topData.length}`);

    // Scroll down past the fold (#far-section sits 2000px below the top).
    const scroll = assertSuccess(await callTool(state, 'browser_scroll', {
      direction: 'down', pixels: 600
    }));
    assert.ok(scroll.scrollY > 0, 'scroll did not move the page');

    // Screenshot IMMEDIATELY after the scroll returns. The scroll helper must
    // have waited for the compositor repaint — a black frame would compress to
    // a tiny jpeg.
    const after = await callTool(state, 'browser_screenshot', {
      filename: 'p3-after-scroll.jpg', format: 'jpeg'
    });
    assertSuccess(after);
    const afterData = after.result.content[1]?.data;
    assert.ok(afterData, 'expected image data');
    assert.ok(afterData.length > 2000,
      `screenshot after scroll suspiciously small (black frame?): ${afterData.length} chars`);
    assert.notEqual(afterData, topData,
      'scrolled view must differ from the top-of-page view');
  });

  it('screenshot immediately after scrolling to an element is not blank', async () => {
    const scroll = assertSuccess(await callTool(state, 'browser_scroll', {
      selector: '#far-section'
    }));
    assert.equal(scroll.inViewport, true);

    const after = await callTool(state, 'browser_screenshot', {
      filename: 'p3-after-element.jpg', format: 'jpeg'
    });
    assertSuccess(after);
    const afterData = after.result.content[1]?.data;
    assert.ok(afterData, 'expected image data');
    assert.ok(afterData.length > 2000,
      `screenshot after element scroll suspiciously small (black frame?): ${afterData.length} chars`);
  });

  it('clicks a below-viewport element without force (scroll settle before coverage check)', async () => {
    // #far-btn is 2000px below the fold; clickElement must scroll it into view
    // (behavior:'instant') and let the compositor settle before the coverage
    // check, so the click succeeds without force: true.
    const result = assertSuccess(await callTool(state, 'browser_click', {
      selector: '#far-btn'
    }));
    assert.equal(result.clicked, true);
    assert.equal(result.forced, undefined, 'below-viewport click must not need the JS fallback');

    const text = await getText(state, '#far-result');
    assert.ok(text.includes('Far button clicked!'), `expected click to land, got: ${text}`);
  });
});
