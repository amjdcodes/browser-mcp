// tests/network.test.js
// ---------------------------------------------------------------------------
// browser_network — record recent network activity (requests, statuses,
// failures) and expose it to an agent. Integration suite (spawns real Chromium)
// using the shared harness.
//
// The fixture page (fixtures/network-page.html) issues, on load:
//   - a 200 request        (/page2.html)
//   - a 404 request        (/api/missing-thing)
//   - a network failure    (http://127.0.0.1:9/ — closed port)
//   - a token request      (/api/x?token=SECRET123)
//   - a 404 subresource    (/does-not-exist.png)
// and sets #net-done to "done" once every request has settled.
// ---------------------------------------------------------------------------

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startFixtureServer,
  startMcpServer,
  stopServer,
  initializeServer,
  makeCallTool,
  assertSuccess
} from './harness.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Poll browser_network until `predicate(result)` is true, or throw. */
async function waitForNetwork(call, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = assertSuccess(await call('browser_network', { filter: 'all' }));
    if (predicate(last)) return last;
    await sleep(150);
  }
  assert.fail(`network predicate not met; last = ${JSON.stringify(last)}`);
}

describe('browser_network', () => {
  let fixture;
  let state;
  let call;
  let origin;

  before(async () => {
    fixture = await startFixtureServer();
    origin = `http://127.0.0.1:${fixture.port}`;
    state = startMcpServer();
    await initializeServer(state, 'network-test');
    call = makeCallTool(state);
  });

  after(async () => {
    await stopServer(state);
    fixture.server.close();
  });

  it('records the page’s requests, including the successful one', async () => {
    assertSuccess(await call('browser_navigate', { url: `${origin}/network-page.html` }));
    const result = await waitForNetwork(call,
      r => r.requests.some(q => q.url && q.url.includes('page2.html')));

    assert.ok(result.count > 0, 'at least one request must be recorded');
    const ok = result.requests.find(q => q.url && q.url.includes('page2.html'));
    assert.equal(ok.status, 200);
    assert.equal(ok.completed, true);
  });

  it('filter: "failed" returns only HTTP >= 400 or network failures', async () => {
    assertSuccess(await call('browser_navigate', { url: `${origin}/network-page.html` }));
    await waitForNetwork(call, r => r.requests.some(q => q.url && q.url.includes('missing-thing')));

    const failed = assertSuccess(await call('browser_network', { filter: 'failed' }));
    assert.ok(failed.count > 0, 'the fixture produces failures');

    // Every returned entry must be a genuine failure.
    for (const entry of failed.requests) {
      const isHttpError = typeof entry.status === 'number' && entry.status >= 400;
      assert.ok(entry.failure || isHttpError, `not a failure: ${JSON.stringify(entry)}`);
    }

    // The 404 and the network-level failure are both present...
    assert.ok(failed.requests.some(q => q.status === 404), 'the 404 must be reported');
    assert.ok(failed.requests.some(q => q.failure), 'the network failure must be reported');
    // ...and the successful page2 request is NOT.
    assert.ok(!failed.requests.some(q => q.url && q.url.includes('page2.html')),
      'the 200 request must not appear under filter: failed');
  });

  it('clear_after empties the record', async () => {
    const cleared = assertSuccess(await call('browser_network', { filter: 'all', clear_after: true }));
    assert.equal(cleared.cleared, true);

    const after = assertSuccess(await call('browser_network', { filter: 'all' }));
    assert.equal(after.count, 0);
    assert.deepEqual(after.requests, []);
  });

  it('clears on main-frame navigation', async () => {
    assertSuccess(await call('browser_navigate', { url: `${origin}/network-page.html` }));
    await waitForNetwork(call, r => r.requests.some(q => q.url && q.url.includes('missing-thing')));

    // Navigate away: the previous page's requests must be dropped.
    assertSuccess(await call('browser_navigate', { url: `${origin}/` }));
    await sleep(300);
    const result = assertSuccess(await call('browser_network', { filter: 'all' }));

    assert.ok(!result.requests.some(q => q.url && q.url.includes('missing-thing')),
      'a request from the previous page leaked into the new page record');
    assert.ok(!result.requests.some(q => q.url && q.url.includes('page2.html')),
      'a request from the previous page leaked into the new page record');
  });

  it('never logs a URL (and its token) to stderr', async () => {
    assertSuccess(await call('browser_navigate', { url: `${origin}/network-page.html` }));
    const result = await waitForNetwork(call,
      r => r.requests.some(q => q.url && q.url.includes('token=SECRET123')));

    // The request IS recorded ...
    assert.ok(result.requests.some(q => q.url && q.url.includes('SECRET123')),
      'the token request must be recorded');

    // ... but the secret never touches the server log.
    await sleep(300);
    assert.ok(!state.stderr.includes('SECRET123'), 'the URL token leaked to stderr!');
  });

  it('has a bounded, truncated response when MAX_NETWORK_LINES is small', async () => {
    const small = startMcpServer({ MAX_NETWORK_LINES: '3' });
    try {
      await initializeServer(small, 'network-truncate-test');
      const smallCall = makeCallTool(small);
      assertSuccess(await smallCall('browser_navigate', { url: `${origin}/network-page.html` }));

      const result = await waitForNetwork(smallCall, r => r.count > 3);
      assert.equal(result.truncated, true);
      assert.equal(result.requests.length, 3, 'the response is cut to MAX_NETWORK_LINES');
      assert.ok(result.droppedCount > 0);
    } finally {
      await stopServer(small);
    }
  });
});
