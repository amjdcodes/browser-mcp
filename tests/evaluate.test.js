import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startFixtureServer,
  startMcpServer,
  stopServer,
  initializeServer,
  makeCallTool,
  assertSuccess,
  navigateToTestPage
} from './harness.js';

describe('browser_evaluate — disabled by default', () => {
  let fixture;
  let state;
  let call;

  before(async () => {
    fixture = await startFixtureServer();
    state = startMcpServer(); // ENABLE_EVAL_JS removed by the harness
    await initializeServer(state, 'eval-disabled-test');
    call = makeCallTool(state);
  });

  after(async () => {
    await stopServer(state);
    fixture.server.close();
  });

  it('returns EVAL_DISABLED without starting the browser', async () => {
    const res = await call('browser_evaluate', { expression: '1 + 1' });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /EVAL_DISABLED/);
    assert.match(res.result.content[0].text, /ENABLE_EVAL_JS/);
    assert.ok(
      !state.stderr.includes('[MCP] Starting browser'),
      'browser must not start when evaluate is disabled'
    );
  });
});

describe('browser_evaluate — enabled', () => {
  let fixture;
  let state;
  let call;

  before(async () => {
    fixture = await startFixtureServer();
    state = startMcpServer({ ENABLE_EVAL_JS: '1' });
    await initializeServer(state, 'eval-test');
    call = makeCallTool(state);
  });

  after(async () => {
    await stopServer(state);
    fixture.server.close();
  });

  beforeEach(async () => {
    await navigateToTestPage(call, fixture.port);
  });

  it('returns primitive values', async () => {
    const num = assertSuccess(await call('browser_evaluate', { expression: '1 + 1' }));
    assert.equal(num.result, 2);
    assert.equal(num.type, 'number');

    const str = assertSuccess(await call('browser_evaluate', { expression: "'hello'" }));
    assert.equal(str.result, 'hello');
    assert.equal(str.type, 'string');

    const bool = assertSuccess(await call('browser_evaluate', { expression: 'true' }));
    assert.equal(bool.result, true);
    assert.equal(bool.type, 'boolean');
  });

  it('returns undefined as null', async () => {
    const res = assertSuccess(await call('browser_evaluate', { expression: 'undefined' }));
    assert.equal(res.result, null);
    assert.equal(res.type, 'undefined');
  });

  it('serializes objects and arrays', async () => {
    const res = assertSuccess(await call('browser_evaluate', {
      expression: "({ a: 1, b: [1, 2, 3], c: 'x' })"
    }));
    assert.deepEqual(res.result, { a: 1, b: [1, 2, 3], c: 'x' });
  });

  it('reads DOM state', async () => {
    const res = assertSuccess(await call('browser_evaluate', {
      expression: "document.querySelectorAll('button').length"
    }));
    assert.equal(typeof res.result, 'number');
    assert.ok(res.result > 0);
  });

  it('represents a DOM node descriptively rather than erroring', async () => {
    const res = assertSuccess(await call('browser_evaluate', { expression: 'document.body' }));
    assert.equal(res.result.__type, 'Element');
    assert.equal(res.result.tag, 'body');
  });

  it('represents a function descriptively', async () => {
    const res = assertSuccess(await call('browser_evaluate', {
      expression: '(function sample(a, b) { return a + b; })'
    }));
    assert.equal(res.result.__type, 'function');
    assert.equal(res.result.name, 'sample');
  });

  it('marks circular references instead of failing', async () => {
    const res = assertSuccess(await call('browser_evaluate', {
      expression: "(() => { const o = { name: 'a' }; o.self = o; return o; })()"
    }));
    assert.equal(res.result.name, 'a');
    assert.equal(res.result.self.__type, 'circular');
  });

  it('awaits promises when await_promise is true', async () => {
    const res = assertSuccess(await call('browser_evaluate', {
      expression: 'Promise.resolve(42)',
      await_promise: true
    }));
    assert.equal(res.result, 42);
  });

  it('represents BigInt and NaN without failing', async () => {
    const big = assertSuccess(await call('browser_evaluate', { expression: '10n' }));
    assert.equal(big.type, 'bigint');

    const nan = assertSuccess(await call('browser_evaluate', { expression: 'NaN' }));
    assert.equal(nan.type, 'number');
    assert.equal(nan.result, 'NaN');
  });

  it('reports in-page exceptions as EVAL_ERROR', async () => {
    const res = await call('browser_evaluate', { expression: "throw new Error('boom')" });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /EVAL_ERROR/);
    assert.match(res.result.content[0].text, /boom/);
  });
});

describe('browser_evaluate — truncation', () => {
  let fixture;
  let state;
  let call;

  before(async () => {
    fixture = await startFixtureServer();
    state = startMcpServer({ ENABLE_EVAL_JS: '1', MAX_EVAL_LENGTH: '50' });
    await initializeServer(state, 'eval-truncate-test');
    call = makeCallTool(state);
  });

  after(async () => {
    await stopServer(state);
    fixture.server.close();
  });

  it('truncates oversized results', async () => {
    await navigateToTestPage(call, fixture.port);
    const res = assertSuccess(await call('browser_evaluate', {
      expression: "'a'.repeat(500)"
    }));
    assert.equal(res.truncated, true);
    assert.equal(typeof res.result, 'string');
    assert.ok(res.result.length < 500);
  });
});
