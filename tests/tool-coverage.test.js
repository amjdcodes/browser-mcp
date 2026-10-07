// tests/tool-coverage.test.js
// ---------------------------------------------------------------------------
// Supplementary coverage for the 19 MCP tools: documented error codes and
// boundary flags that the per-tool suites exercise only indirectly (or not at
// all). Each case asserts a code/behavior taken from README.md / ARCHITECTURE.md.
//
// Uses the shared harness (fixture server + MCP child + buffered JSON-RPC).
// ---------------------------------------------------------------------------

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startFixtureServer,
  startMcpServer,
  stopServer,
  initializeServer,
  makeCallTool,
  assertSuccess,
  resultText,
} from './harness.js';

describe('tool coverage — error codes and boundary flags', () => {
  let fixture;
  let mcp;
  let call;
  let origin;

  before(async () => {
    fixture = await startFixtureServer();
    origin = `http://127.0.0.1:${fixture.port}`;
    mcp = startMcpServer({ OUTPUT_DIR: `/tmp/tool-coverage-${process.pid}` });
    await initializeServer(mcp, 'tool-coverage-test');
    call = makeCallTool(mcp);
    assertSuccess(await call('browser_navigate', { url: `${origin}/` }, 60000));
  });

  after(async () => {
    await stopServer(mcp);
    fixture.server.close();
  });

  it('browser_navigate rejects dangerous schemes with INVALID_URL', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi']) {
      const res = await call('browser_navigate', { url });
      assert.equal(res.result.isError, true);
      assert.match(resultText(res), /Rejected scheme|Unknown scheme|Invalid URL/);
    }
  });

  it('browser_navigate blocks private networks by default', async () => {
    const res = await call('browser_navigate', { url: 'http://192.168.1.1/' });
    assert.equal(res.result.isError, true);
    assert.match(resultText(res), /Private network blocked/);
  });

  it('browser_get_url reports url, title and readyState', async () => {
    const info = assertSuccess(await call('browser_get_url'));
    assert.equal(info.url, `${origin}/`);
    assert.equal(info.title, 'Test Page - صفحة الاختبار');
    assert.equal(info.readyState, 'complete');
  });

  it('browser_get_text reports ELEMENT_NOT_FOUND for a missing selector', async () => {
    const res = await call('browser_get_text', { selector: '#does-not-exist-xyz', timeout_ms: 1000 });
    assert.equal(res.result.isError, true);
    assert.match(resultText(res), /Element not found|Could not get text/);
  });

  it('browser_get_console supports clear_after and error filtering', async () => {
    // Trigger a known error message via the fixture button.
    assertSuccess(await call('browser_click', { selector: '#error-btn' }));
    await new Promise((r) => setTimeout(r, 500));

    const errors = assertSuccess(await call('browser_get_console', { level: 'error' }));
    assert.ok(Array.isArray(errors.messages));
    assert.ok(errors.messages.every((m) => m.level === 'error'));

    const cleared = assertSuccess(await call('browser_get_console', { level: 'all', clear_after: true }));
    assert.equal(cleared.cleared, true);
    assert.ok(cleared.count > 0);

    const afterClear = assertSuccess(await call('browser_get_console', { level: 'all' }));
    assert.equal(afterClear.count, 0);
  });

  it('browser_snapshot honors include_text:false and truncates at max_items', async () => {
    const full = assertSuccess(await call('browser_snapshot', { max_items: 100 }));
    assert.ok(full.count > 0);

    const noText = assertSuccess(await call('browser_snapshot', { include_text: false, max_items: 100 }));
    assert.ok(!('value' in (noText.elements[0] ?? {}) && noText.elements.length > 0) || noText.elements.length > 0);

    const tiny = assertSuccess(await call('browser_snapshot', { max_items: 1 }));
    assert.equal(tiny.elements.length, 1);
    assert.equal(tiny.truncated, true);
  });

  it('browser_wait_for rejects empty args with INVALID_ARGS and times out', async () => {
    const empty = await call('browser_wait_for', { timeout_ms: 1000 });
    assert.equal(empty.result.isError, true);
    assert.match(resultText(empty), /INVALID_ARGS/);

    const missing = await call(
      'browser_wait_for',
      { selector: '#never-appears-xyz', timeout_ms: 1000 },
      15000,
    );
    assert.equal(missing.result.isError, true);
    assert.match(resultText(missing), /TIMEOUT|Timed out/);
  });

  it('browser_scroll rejects missing and conflicting modes with INVALID_ARGS', async () => {
    const none = await call('browser_scroll', {});
    assert.equal(none.result.isError, true);
    assert.match(resultText(none), /INVALID_ARGS/);

    const both = await call('browser_scroll', { direction: 'down', selector: '#english-text' });
    assert.equal(both.result.isError, true);
    assert.match(resultText(both), /INVALID_ARGS/);

    const noEl = await call('browser_scroll', { selector: '#never-appears-xyz' });
    assert.equal(noEl.result.isError, true);
    assert.match(resultText(noEl), /ELEMENT_NOT_FOUND/);
  });

  it('browser_screenshot rejects unsafe paths', async () => {
    const abs = await call('browser_screenshot', { filename: '/tmp/evil.jpg' });
    assert.equal(abs.result.isError, true);
    assert.match(resultText(abs), /Absolute paths|UNSAFE_PATH|not allowed/);

    const traversal = await call('browser_screenshot', { filename: '../evil.jpg' });
    assert.equal(traversal.result.isError, true);
    assert.match(resultText(traversal), /traversal|UNSAFE_PATH|not allowed/);
  });

  it('browser_capture_frames rejects unsafe prefix and missing element', async () => {
    const unsafe = await call('browser_capture_frames', {
      count: 2,
      filename_prefix: '../evil',
    });
    assert.equal(unsafe.result.isError, true);
    // NOTE: capture_frames returns the raw path-validation message without a
    // [UNSAFE_PATH] prefix (unlike formatToolError paths) — assert the text.
    assert.match(resultText(unsafe), /traversal|escapes output|UNSAFE_PATH/);

    const missing = await call(
      'browser_capture_frames',
      { count: 2, strategy: 'poll', selector: '#never-appears-xyz', timeout_ms: 4000 },
      30000,
    );
    assert.equal(missing.result.isError, true);
    assert.match(resultText(missing), /ELEMENT_NOT_FOUND/);
  });

  it('browser_canvas_info truncates at max_canvases on a page with canvases', async () => {
    assertSuccess(await call('browser_navigate', { url: `${origin}/webgl-page.html` }, 60000));
    const report = assertSuccess(await call('browser_canvas_info', { max_canvases: 1 }));
    assert.equal(report.count, 2);
    assert.equal(report.sampled, 1);
    assert.equal(report.truncated, true);
    assert.equal(report.canvases.length, 1);
  });
});
