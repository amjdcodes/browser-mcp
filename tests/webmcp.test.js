// tests/webmcp.test.js
// ---------------------------------------------------------------------------
// WebMCP tools (browser_webmcp_list_tools / browser_webmcp_call_tool).
//
// These tests are intentionally transport-agnostic: they pass whether the
// installed Chromium exposes the experimental CDP WebMCP domain (browser-mcp
// then uses it) or not (browser-mcp falls back to the in-page
// document.modelContext API, which fixtures/webmcp-page.html polyfills). The
// tool behavior and error codes are identical either way.
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
  resultText
} from './harness.js';

// A tool result may arrive as the raw execute() value ({ content: [...] }),
// as a bare string, or wrapped — normalize to the first text it carries.
function firstText(output) {
  if (output == null) return null;
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    if (Array.isArray(output.content) && output.content[0]) return output.content[0].text;
    if (typeof output.text === 'string') return output.text;
  }
  return null;
}

describe('browser_webmcp_* tools', () => {
  let fixture, mcp, call, origin;

  before(async () => {
    fixture = await startFixtureServer();
    origin = `http://127.0.0.1:${fixture.port}`;
    mcp = startMcpServer({ OUTPUT_DIR: `/tmp/webmcp-${process.pid}` });
    await initializeServer(mcp, 'webmcp-test');
    call = makeCallTool(mcp);
  });

  after(async () => {
    await stopServer(mcp);
    fixture.server.close();
  });

  it('refuses with WEBMCP_DISABLED when the gate is off', async () => {
    const off = startMcpServer({ ENABLE_WEBMCP: '0', OUTPUT_DIR: `/tmp/webmcp-off-${process.pid}` });
    try {
      await initializeServer(off, 'webmcp-off');
      const offCall = makeCallTool(off);

      const list = await offCall('browser_webmcp_list_tools', {});
      assert.equal(list.result.isError, true);
      assert.match(resultText(list), /WEBMCP_DISABLED/);

      const invoked = await offCall('browser_webmcp_call_tool', { name: 'add', input: { a: 1, b: 1 } });
      assert.equal(invoked.result.isError, true);
      assert.match(resultText(invoked), /WEBMCP_DISABLED/);
    } finally {
      await stopServer(off);
    }
  });

  it('lists the tools the page declares, then invokes one', async () => {
    assertSuccess(await call('browser_navigate', { url: `${origin}/webmcp-page.html` }, 60000));

    const listed = assertSuccess(await call('browser_webmcp_list_tools', {}));
    assert.equal(listed.webmcp, true);
    assert.equal(listed.untrusted, true);
    assert.equal(listed.count, 3);
    assert.deepEqual(listed.tools.map(t => t.name).sort(), ['add', 'big', 'fail']);

    const add = listed.tools.find(t => t.name === 'add');
    assert.equal(add.inputSchema.type, 'object');

    const invoked = assertSuccess(
      await call('browser_webmcp_call_tool', { name: 'add', input: { a: 2, b: 40 } })
    );
    assert.equal(invoked.untrusted, true);
    assert.equal(invoked.status, 'Completed');
    assert.equal(firstText(invoked.output), '42');
  });

  it('maps a throwing tool to WEBMCP_CALL_FAILED', async () => {
    const res = await call('browser_webmcp_call_tool', { name: 'fail', input: {} });
    assert.equal(res.result.isError, true);
    assert.match(resultText(res), /WEBMCP_CALL_FAILED/);
  });

  it('maps an unknown tool to WEBMCP_TOOL_NOT_FOUND', async () => {
    const res = await call('browser_webmcp_call_tool', { name: 'does-not-exist-xyz', input: {} });
    assert.equal(res.result.isError, true);
    assert.match(resultText(res), /WEBMCP_TOOL_NOT_FOUND/);
  });

  it('on a page without tools: empty catalog when supported, else WEBMCP_UNAVAILABLE', async () => {
    assertSuccess(await call('browser_navigate', { url: `${origin}/test-page.html` }, 60000));
    const snap = assertSuccess(await call('browser_snapshot', {}));
    assert.equal(snap.webmcpEnabled, true);

    const res = await call('browser_webmcp_list_tools', {});
    if (snap.webmcpAvailable === true) {
      const empty = assertSuccess(res);
      assert.deepEqual(empty.tools, []);
      assert.equal(empty.count, 0);
    } else {
      assert.equal(res.result.isError, true);
      assert.match(resultText(res), /WEBMCP_UNAVAILABLE/);
    }
  });

  it('truncates oversized tool results', async () => {
    const small = startMcpServer({
      ENABLE_WEBMCP: '1',
      MAX_WEBMCP_RESULT_LENGTH: '1000',
      OUTPUT_DIR: `/tmp/webmcp-small-${process.pid}`
    });
    try {
      await initializeServer(small, 'webmcp-small');
      const smallCall = makeCallTool(small);
      assertSuccess(await smallCall('browser_navigate', { url: `${origin}/webmcp-page.html` }, 60000));

      const res = assertSuccess(await smallCall('browser_webmcp_call_tool', { name: 'big', input: {} }));
      assert.equal(res.truncated, true);
      assert.match(res.reason, /MAX_WEBMCP_RESULT_LENGTH/);
    } finally {
      await stopServer(small);
    }
  });
});
