import { spawn } from 'node:child_process';
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function sendRequest(proc, request) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(request);
    proc.stdin.write(json + '\n');
    
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for response'));
    }, 30000);
    
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
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  };

  await sendRequest(proc, initRequest);

  const initializedNotification = {
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  };
  proc.stdin.write(JSON.stringify(initializedNotification) + '\n');

  await new Promise(resolve => setTimeout(resolve, 200));
}

describe('MCP Integration', () => {
  let serverProc;

  afterEach(async () => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      serverProc = null;
    }
  });

  it('navigates to about:blank successfully', async () => {
    serverProc = spawn('node', ['index.js'], {
      cwd: '/root/browser-mcp',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderrOutput = '';
    serverProc.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    await initializeServer(serverProc);

    const toolCallRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'browser_navigate',
        arguments: {
          url: 'about:blank'
        }
      }
    };

    const toolCallResponse = await sendRequest(serverProc, toolCallRequest);
    
    assert.ok(toolCallResponse.result);
    assert.notEqual(toolCallResponse.result.isError, true);
    assert.ok(toolCallResponse.result.content[0].text);
    
    const result = JSON.parse(toolCallResponse.result.content[0].text);
    assert.equal(result.url, 'about:blank');
    assert.ok(result.title !== undefined);

    assert.ok(stderrOutput.includes('[MCP] Starting browser'));
    assert.ok(stderrOutput.includes('[MCP] Navigating to'));
  });

  it('returns error for invalid URL without crashing', async () => {
    serverProc = spawn('node', ['index.js'], {
      cwd: '/root/browser-mcp',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    await initializeServer(serverProc);

    const toolCallRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'browser_navigate',
        arguments: {
          url: 'file:///etc/passwd'
        }
      }
    };

    const toolCallResponse = await sendRequest(serverProc, toolCallRequest);
    
    assert.ok(toolCallResponse.result);
    assert.equal(toolCallResponse.result.isError, true);
    assert.ok(toolCallResponse.result.content[0].text.includes('Rejected scheme'));

    assert.ok(serverProc.exitCode === null, 'Server should still be running');
  });

  it('handles connection errors gracefully', async () => {
    serverProc = spawn('node', ['index.js'], {
      cwd: '/root/browser-mcp',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    await initializeServer(serverProc);

    const toolCallRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'browser_navigate',
        arguments: {
          url: 'http://127.0.0.1:9999',
          timeout_ms: 2000
        }
      }
    };

    const toolCallResponse = await sendRequest(serverProc, toolCallRequest);
    
    assert.ok(toolCallResponse.result);
    assert.notEqual(toolCallResponse.result.isError, true);
    
    const result = JSON.parse(toolCallResponse.result.content[0].text);
    assert.ok(result.url.includes('chrome-error') || result.url.includes('127.0.0.1'));

    assert.ok(serverProc.exitCode === null, 'Server should still be running');
  });

  it('browser starts lazily on first tool call', async () => {
    serverProc = spawn('node', ['index.js'], {
      cwd: '/root/browser-mcp',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderrOutput = '';
    serverProc.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    assert.ok(!stderrOutput.includes('[Browser] Found Chromium'), 'Browser should not start yet');

    await initializeServer(serverProc);

    const toolCallRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'browser_navigate',
        arguments: {
          url: 'about:blank'
        }
      }
    };

    await sendRequest(serverProc, toolCallRequest);

    assert.ok(stderrOutput.includes('[MCP] Starting browser'), 'Browser should start on first call');
    assert.ok(stderrOutput.includes('[Browser] Found Chromium'), 'Browser should be found');
  });
});

// ---------------------------------------------------------------------------
// Phase 7 fixes: same-document anchor navigation + screenshot delay_ms
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');

let anchorFixtureServer;
let anchorFixturePort;

async function startAnchorFixtureServer() {
  return new Promise((resolve) => {
    anchorFixtureServer = createServer((req, res) => {
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
    anchorFixtureServer.maxRequestsPerSocket = 0;
    anchorFixtureServer.listen(0, '127.0.0.1', () => {
      anchorFixturePort = anchorFixtureServer.address().port;
      resolve();
    });
  });
}

describe('Phase 7 fixes', () => {
  let serverProc;

  before(async () => {
    await startAnchorFixtureServer();
  });

  after(async () => {
    anchorFixtureServer?.closeAllConnections?.();
    anchorFixtureServer?.close();
  });

  afterEach(async () => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      serverProc = null;
    }
  });

  async function startServer() {
    serverProc = spawn('node', ['index.js'], {
      cwd: '/root/browser-mcp',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OUTPUT_DIR: '/tmp/phase7-shots', IDLE_SHUTDOWN_MS: '0' }
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    await initializeServer(serverProc);
    return serverProc;
  }

  async function call(name, args = {}) {
    const response = await sendRequest(serverProc, {
      jsonrpc: '2.0',
      id: 900 + Math.floor(Math.random() * 100),
      method: 'tools/call',
      params: { name, arguments: args }
    });
    return response;
  }

  it('navigates to a hash anchor on the same page in < 2 seconds', async () => {
    await startServer();
    const base = `http://127.0.0.1:${anchorFixturePort}/`;

    // Full-page navigation first.
    const first = await call('browser_navigate', { url: base });
    assert.notEqual(first.result.isError, true);
    assert.equal(JSON.parse(first.result.content[0].text).url, base);

    // Same-document hash navigation — must NOT wait for Page.loadEventFired.
    const started = Date.now();
    const anchor = await call('browser_navigate', { url: `${base}#far-section` });
    const elapsed = Date.now() - started;

    assert.notEqual(anchor.result.isError, true,
      `anchor navigation failed: ${anchor.result?.content?.[0]?.text}`);
    const result = JSON.parse(anchor.result.content[0].text);
    assert.equal(result.url, `${base}#far-section`);
    assert.ok(result.title.length > 0, 'title should be present');
    assert.ok(elapsed < 2000, `anchor navigation took ${elapsed}ms (> 2s)`);
  });

  it('screenshot honors delay_ms', async () => {
    await startServer();
    await call('browser_navigate', { url: `http://127.0.0.1:${anchorFixturePort}/` });

    const started = Date.now();
    const response = await call('browser_screenshot', {
      filename: 'delayed.jpg',
      format: 'jpeg',
      delay_ms: 600
    });
    const elapsed = Date.now() - started;

    assert.notEqual(response.result.isError, true);
    assert.ok(elapsed >= 500, `delay_ms not honored: elapsed ${elapsed}ms`);
  });

  it('navigates to a hash URL on a different page normally (full navigation)', async () => {
    await startServer();
    // page2.html has no elements; use a hash on page2 (full reload path —
    // different pathname from the test page, so NOT same-document).
    const first = await call('browser_navigate', { url: `http://127.0.0.1:${anchorFixturePort}/` });
    assert.notEqual(first.result.isError, true);

    const started = Date.now();
    const second = await call('browser_navigate', { url: `http://127.0.0.1:${anchorFixturePort}/page2.html#top` });
    const elapsed = Date.now() - started;

    assert.notEqual(second.result.isError, true);
    const result = JSON.parse(second.result.content[0].text);
    assert.ok(result.url.includes('page2.html'), `expected page2 URL, got ${result.url}`);
    assert.ok(elapsed < 10000, `full navigation took ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: full-page screenshot completeness (lazy rendering + pixel scaling)
// ---------------------------------------------------------------------------

import { inflateSync } from 'node:zlib';

/**
 * Minimal PNG decoder (RGB/RGBA/grayscale, 8-bit) for test assertions.
 * Returns { width, height, pixels } where pixels is RGBA.
 */
function decodePng(buffer) {
  let offset = 8;
  let width, height, channels = 4, colorType;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (colorType === 2) channels = 3;
  else if (colorType === 0) channels = 1;

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const recon = Buffer.alloc(stride);

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? recon[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let val = line[x];
      switch (filter) {
        case 0: break;
        case 1: val += a; break;
        case 2: val += b; break;
        case 3: val += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          val += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
      }
      recon[x] = val & 0xFF;
    }

    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      pixels[d] = recon[s];
      pixels[d + 1] = channels > 1 ? recon[s + 1] : recon[s];
      pixels[d + 2] = channels > 1 ? recon[s + 2] : recon[s];
      pixels[d + 3] = channels === 4 ? recon[s + 3] : 255;
    }
    prev.set(recon);
  }
  return { width, height, pixels };
}

/** Average RGB of a horizontal band of rows. */
function avgColor(png, y0, y1) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < Math.min(y1, png.height); y += 2) {
    for (let x = 0; x < png.width; x += 5) {
      const i = (y * png.width + x) * 4;
      r += png.pixels[i]; g += png.pixels[i + 1]; b += png.pixels[i + 2];
      n++;
    }
  }
  return n ? { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) } : null;
}

describe('Full-page screenshot completeness (Phase 2)', () => {
  let fullPageFixtureServer;
  let fullPageFixturePort;
  let serverProc;

  before(async () => {
    fullPageFixtureServer = createServer((req, res) => {
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
    fullPageFixtureServer.maxRequestsPerSocket = 0;
    await new Promise((resolve) => {
      fullPageFixtureServer.listen(0, '127.0.0.1', () => {
        fullPageFixturePort = fullPageFixtureServer.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    fullPageFixtureServer?.closeAllConnections?.();
    fullPageFixtureServer?.close();
  });

  afterEach(async () => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      serverProc = null;
    }
  });

  // Buffering MCP client: large image responses arrive as partial chunks, so
  // lines must be accumulated before parsing.
  function startServer() {
    serverProc = spawn('node', ['index.js'], {
      cwd: '/root/browser-mcp',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OUTPUT_DIR: '/tmp/phase2-shots',
        IDLE_SHUTDOWN_MS: '0',
        // The RTL test reads the page's own viewport measurements.
        ENABLE_EVAL_JS: '1'
      }
    });
    let stdoutBuffer = '';
    const pending = new Map();
    serverProc.stdout.on('data', (d) => {
      stdoutBuffer += d.toString();
      let idx;
      while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pending.has(msg.id)) {
            const entry = pending.get(msg.id);
            pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg);
          }
        } catch { /* partial line */ }
      }
    });
    serverProc._pending = pending;
    return serverProc;
  }

  function sendRequest(proc, request, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc._pending.delete(request.id);
        reject(new Error(`Timeout waiting for response (id ${request.id})`));
      }, timeoutMs);
      proc._pending.set(request.id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  async function init(proc) {
    await sendRequest(proc, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'fullpage-test', version: '1.0.0' }
      }
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  let reqId = 1000;
  async function call(proc, name, args = {}) {
    return sendRequest(proc, {
      jsonrpc: '2.0', id: reqId++, method: 'tools/call',
      params: { name, arguments: args }
    });
  }

  it('full-page screenshot triggers lazy (IntersectionObserver) rendering', async () => {
    await startServer();
    await init(serverProc);

    const nav = await call(serverProc, 'browser_navigate', {
      url: `http://127.0.0.1:${fullPageFixturePort}/lazy-page.html`
    });
    assert.notEqual(nav.result.isError, true);

    // Before the screenshot: lazy section is NOT yet rendered.
    const before = await call(serverProc, 'browser_get_text', { selector: '#lazy-section' });
    assert.notEqual(before.result.isError, true);
    const beforeText = JSON.parse(before.result.content[0].text).text;
    assert.ok(beforeText.includes('(not loaded yet)'), `expected unloaded state, got: ${beforeText}`);

    // Full-page screenshot — the warm-up scroll must trigger the observer.
    const started = Date.now();
    const shot = await call(serverProc, 'browser_screenshot', {
      filename: 'lazy-full.png', format: 'png', full_page: true
    });
    assert.notEqual(shot.result.isError, true,
      `full-page screenshot failed: ${shot.result?.content?.[0]?.text}`);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 15000, `warm-up + capture took ${elapsed}ms`);

    // After: the lazy content was rendered during the warm-up scroll.
    const after = await call(serverProc, 'browser_get_text', { selector: '#lazy-section' });
    assert.notEqual(after.result.isError, true);
    const afterText = JSON.parse(after.result.content[0].text).text;
    assert.ok(afterText.includes('Lazy content loaded'),
      `warm-up scroll did not trigger lazy rendering, got: ${afterText}`);
  });

  it('full-page screenshot of a >16M pixel page is scaled, not cropped', async () => {
    await startServer();
    await init(serverProc);

    await call(serverProc, 'browser_navigate', {
      url: `http://127.0.0.1:${fullPageFixturePort}/tall-page.html`
    });

    const shot = await call(serverProc, 'browser_screenshot', {
      filename: 'tall-full.png', format: 'png', full_page: true
    });
    assert.notEqual(shot.result.isError, true,
      `screenshot failed: ${shot.result?.content?.[0]?.text}`);

    const meta = JSON.parse(shot.result.content[0].text);
    assert.equal(meta.truncated, true, 'page exceeds the pixel limit, truncated must be true');
    assert.ok(meta.size > 1000, 'image suspiciously small');

    const png = decodePng(Buffer.from(shot.result.content[1].data, 'base64'));

    // The tall fixture is 3000x19400 CSS px; the output must be a DOWNSCALED
    // full page (aspect ratio preserved), not a viewport-sized crop.
    assert.ok(png.width > 1000, `expected a wide (full-page) image, got ${png.width}`);
    assert.ok(png.height > 5000, `expected a tall (full-page) image, got ${png.height}`);

    // Content check: top bar is red, middle green, bottom bar blue. If the
    // image were cropped (old clip-dimension bug), the bottom would be green
    // (middle of the page), not blue.
    const top = avgColor(png, 0, 20);
    const bottom = avgColor(png, png.height - 20, png.height);
    assert.ok(top.r > 200 && top.g < 80 && top.b < 80,
      `top should be red, got ${JSON.stringify(top)}`);
    assert.ok(bottom.b > 200 && bottom.r < 80 && bottom.g < 80,
      `bottom should be blue (full page captured), got ${JSON.stringify(bottom)}`);
  });

  it('leaves the viewport unchanged after a full-page screenshot', async () => {
    await startServer();
    await init(serverProc);

    await call(serverProc, 'browser_navigate', {
      url: `http://127.0.0.1:${fullPageFixturePort}/tall-page.html`
    });

    const full = await call(serverProc, 'browser_screenshot', {
      filename: 'tall-full.png', format: 'png', full_page: true
    });
    assert.notEqual(full.result.isError, true);

    // A subsequent VIEWPORT screenshot must have normal viewport dimensions
    // (not the 3000px-wide / 19400px-tall emulated viewport).
    const view = await call(serverProc, 'browser_screenshot', {
      filename: 'viewport-after.png', format: 'png'
    });
    assert.notEqual(view.result.isError, true);

    const png = decodePng(Buffer.from(view.result.content[1].data, 'base64'));
    assert.ok(png.width < 2000, `viewport width leaked from the capture: ${png.width}`);
    assert.ok(png.height < 2000, `viewport height leaked from the capture: ${png.height}`);
    assert.ok(png.height < 1500, `expected a viewport-height image, got ${png.height}`);
  });

  it('captures an RTL page without inflating the viewport', async () => {
    await startServer();
    await init(serverProc);

    const nav = await call(serverProc, 'browser_navigate', {
      url: `http://127.0.0.1:${fullPageFixturePort}/rtl-page.html`
    });
    assert.notEqual(nav.result.isError, true);

    await call(serverProc, 'browser_resize', { width: 1440, height: 900 });
    await call(serverProc, 'browser_scroll', { direction: 'top' });

    const shot = await call(serverProc, 'browser_screenshot', {
      filename: 'rtl-full.png', format: 'png', full_page: true
    });
    assert.notEqual(shot.result.isError, true,
      `full-page screenshot failed: ${shot.result?.content?.[0]?.text}`);

    const png = decodePng(Buffer.from(shot.result.content[1].data, 'base64'));

    // The 100vh hero (900px) plus the 2000px content column.
    assert.ok(png.height > 2500, `expected the whole document, got ${png.height}px tall`);

    // The middle of the page must show the content column, not the hero. When
    // the viewport is inflated to the document height, 100vh fills the entire
    // image with the hero colour — the distortion this test guards against.
    const mid = avgColor(png, 1400, 1600);
    assert.ok(mid.r < 100, `mid-band shows a stretched 100vh hero: ${JSON.stringify(mid)}`);
    assert.ok(mid.g > 120, `mid-band should be the content column: ${JSON.stringify(mid)}`);

    // The capture must not resize the viewport: the height:100% fixed sidebar
    // would otherwise stretch to the document height, smearing over the image.
    const measured = await call(serverProc, 'browser_evaluate', {
      expression: '({ maxInner: window.__maxInnerHeight, maxSidebar: window.__maxSidebarHeight })'
    });
    assert.notEqual(measured.result.isError, true);
    const { maxInner, maxSidebar } = JSON.parse(measured.result.content[0].text).result;
    assert.ok(maxInner <= 901, `viewport was inflated during the capture: ${maxInner}px`);
    assert.ok(maxSidebar <= 901, `fixed sidebar stretched to ${maxSidebar}px`);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: scroll → screenshot must capture the scrolled content (a black
// intermediate frame would be captured if the scroll helpers returned before
// the compositor repainted). Pixel content of the tall-page fixture's colored
// bands is the discriminating assertion.
// ---------------------------------------------------------------------------

describe('Scroll then screenshot pixel content (Phase 3)', () => {
  let p3FixtureServer;
  let p3FixturePort;
  let serverProc;

  before(async () => {
    p3FixtureServer = createServer((req, res) => {
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
    p3FixtureServer.maxRequestsPerSocket = 0;
    await new Promise((resolve) => {
      p3FixtureServer.listen(0, '127.0.0.1', () => {
        p3FixturePort = p3FixtureServer.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    p3FixtureServer?.closeAllConnections?.();
    p3FixtureServer?.close();
  });

  afterEach(async () => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      serverProc = null;
    }
  });

  function startServer() {
    serverProc = spawn('node', ['index.js'], {
      cwd: '/root/browser-mcp',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OUTPUT_DIR: '/tmp/phase3-shots', IDLE_SHUTDOWN_MS: '0' }
    });
    let stdoutBuffer = '';
    const pending = new Map();
    serverProc.stdout.on('data', (d) => {
      stdoutBuffer += d.toString();
      let idx;
      while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pending.has(msg.id)) {
            const entry = pending.get(msg.id);
            pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg);
          }
        } catch { /* partial line */ }
      }
    });
    serverProc._pending = pending;
    return serverProc;
  }

  function sendRequest(proc, request, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc._pending.delete(request.id);
        reject(new Error(`Timeout waiting for response (id ${request.id})`));
      }, timeoutMs);
      proc._pending.set(request.id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  async function init(proc) {
    await sendRequest(proc, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'scroll-pixel-test', version: '1.0.0' }
      }
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  let reqId = 2000;
  async function call(proc, name, args = {}) {
    return sendRequest(proc, {
      jsonrpc: '2.0', id: reqId++, method: 'tools/call',
      params: { name, arguments: args }
    });
  }

  /** Average color of the whole viewport image. */
  function avgColorAll(png) {
    return avgColor(png, 0, png.height);
  }

  it('captures the scrolled-to band, not a black frame (directional scroll)', async () => {
    await startServer();
    await init(serverProc);

    await call(serverProc, 'browser_navigate', {
      url: `http://127.0.0.1:${p3FixturePort}/tall-page.html`
    });

    // Scroll into the GREEN band (rows 200..19200 of the 19400px page).
    const scroll = await call(serverProc, 'browser_scroll', {
      direction: 'down', pixels: 5000
    });
    assert.notEqual(scroll.result.isError, true,
      `scroll failed: ${scroll.result?.content?.[0]?.text}`);
    assert.ok(JSON.parse(scroll.result.content[0].text).scrollY >= 5000,
      'scroll did not reach the green band');

    // Screenshot immediately — the scroll helper must have settled the
    // compositor. A black intermediate frame (the bug) fails the assertion.
    const shot = await call(serverProc, 'browser_screenshot', {
      filename: 'p3-green.png', format: 'png'
    });
    assert.notEqual(shot.result.isError, true,
      `screenshot failed: ${shot.result?.content?.[0]?.text}`);

    const png = decodePng(Buffer.from(shot.result.content[1].data, 'base64'));
    assert.ok(png.height < 1000, 'expected a viewport screenshot');
    const avg = avgColorAll(png);
    assert.ok(avg.g > 150 && avg.g > avg.r + 50 && avg.g > avg.b + 50,
      `expected green content after scrolling, got ${JSON.stringify(avg)} (black frame?)`);
  });

  it('captures the bottom band after scrolling to the page bottom', async () => {
    await startServer();
    await init(serverProc);

    await call(serverProc, 'browser_navigate', {
      url: `http://127.0.0.1:${p3FixturePort}/tall-page.html`
    });

    const scroll = await call(serverProc, 'browser_scroll', {
      direction: 'bottom'
    });
    assert.notEqual(scroll.result.isError, true);

    // The page is 19400px tall; the viewport (437px) is inside the bottom
    // blue band after scrolling to the very bottom.
    const shot = await call(serverProc, 'browser_screenshot', {
      filename: 'p3-blue.png', format: 'png'
    });
    assert.notEqual(shot.result.isError, true);

    const png = decodePng(Buffer.from(shot.result.content[1].data, 'base64'));
    const avg = avgColorAll(png);
    // The page's bottom band (200px blue) does not fill the whole viewport,
    // so the last viewport is blue-dominant mixed with the green band above —
    // assert the blue content is clearly present and the frame is not blank.
    assert.ok(avg.b > 100 && avg.b > avg.r + 50,
      `expected blue content at the page bottom, got ${JSON.stringify(avg)} (blank frame?)`);
  });

  it('captures the anchor target after same-document navigation (Phase 4 / Problem 9)', async () => {
    await startServer();
    await init(serverProc);

    const base = `http://127.0.0.1:${p3FixturePort}/tall-page.html`;

    // Full-page navigation: viewport shows the red top bar (rows 0..200).
    const nav = await call(serverProc, 'browser_navigate', { url: base });
    assert.notEqual(nav.result.isError, true);

    // Same-document anchor navigation to #middle (200px down, into green).
    const started = Date.now();
    const anchor = await call(serverProc, 'browser_navigate', { url: `${base}#middle` });
    const elapsed = Date.now() - started;

    assert.notEqual(anchor.result.isError, true,
      `anchor navigation failed: ${anchor.result?.content?.[0]?.text}`);
    assert.equal(JSON.parse(anchor.result.content[0].text).url, `${base}#middle`);
    assert.ok(elapsed < 3000, `anchor navigation took ${elapsed}ms`);

    // Screenshot immediately after — the navigate handler's settle (200ms +
    // double-rAF) must have produced a valid frame showing the green band.
    const shot = await call(serverProc, 'browser_screenshot', {
      filename: 'p4-anchor.png', format: 'png'
    });
    assert.notEqual(shot.result.isError, true,
      `screenshot failed: ${shot.result?.content?.[0]?.text}`);

    const png = decodePng(Buffer.from(shot.result.content[1].data, 'base64'));
    const avg = avgColorAll(png);
    assert.ok(avg.g > 150 && avg.g > avg.r + 50 && avg.g > avg.b + 50,
      `expected green content at the anchor target, got ${JSON.stringify(avg)} (blank frame?)`);
  });
});
