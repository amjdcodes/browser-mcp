// tests/select.test.js
// ---------------------------------------------------------------------------
// browser_select — set a <select> value by value | label | index, and verify the
// change reaches page listeners. Integration suite (spawns real Chromium) using
// the shared harness.
// ---------------------------------------------------------------------------

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startFixtureServer,
  startMcpServer,
  stopServer,
  initializeServer,
  makeCallTool,
  assertSuccess,
  resultText,
  getText,
  navigateToTestPage
} from './harness.js';

describe('browser_select', () => {
  let fixture;
  let state;
  let call;

  before(async () => {
    fixture = await startFixtureServer();
    state = startMcpServer();
    await initializeServer(state, 'select-test');
    call = makeCallTool(state);
  });

  after(async () => {
    await stopServer(state);
    fixture.server.close();
  });

  beforeEach(async () => {
    await navigateToTestPage(call, fixture.port);
  });

  it('selects by value and get_text reflects it', async () => {
    const res = assertSuccess(await call('browser_select', {
      selector: '#select',
      value: 'option2'
    }));
    assert.equal(res.selected, true);
    assert.equal(res.selector, '#select');
    assert.equal(res.value, 'option2');
    assert.equal(res.label, 'Option 2');
    assert.equal(res.index, 1);

    assert.equal(await getText(call, '#select'), 'option2');
  });

  it('selects by label', async () => {
    const res = assertSuccess(await call('browser_select', {
      selector: '#select',
      label: 'Option 3'
    }));
    assert.equal(res.value, 'option3');
    assert.equal(res.label, 'Option 3');
    assert.equal(await getText(call, '#select'), 'option3');
  });

  it('selects by index', async () => {
    const res = assertSuccess(await call('browser_select', {
      selector: '#select',
      index: 0
    }));
    assert.equal(res.value, 'option1');
    assert.equal(res.index, 0);
    assert.equal(await getText(call, '#select'), 'option1');
  });

  it('dispatches a change event the page listener observes', async () => {
    // The fixture has a #select change listener that mirrors the value into
    // #select-echo. If change never fired, this would still read "(none)".
    assertSuccess(await call('browser_select', { selector: '#select', value: 'option3' }));
    assert.equal(await getText(call, '#select-echo'), 'option3');

    assertSuccess(await call('browser_select', { selector: '#select', value: 'option1' }));
    assert.equal(await getText(call, '#select-echo'), 'option1');
  });

  it('reports OPTION_NOT_FOUND for a value that does not exist', async () => {
    const res = await call('browser_select', { selector: '#select', value: 'does-not-exist' });
    assert.equal(res.result.isError, true);
    assert.match(resultText(res), /OPTION_NOT_FOUND/);
  });

  it('reports ELEMENT_NOT_SELECT for a non-select element', async () => {
    const res = await call('browser_select', { selector: '#text-input', value: 'option1' });
    assert.equal(res.result.isError, true);
    assert.match(resultText(res), /ELEMENT_NOT_SELECT/);
  });

  it('rejects when no criterion is provided', async () => {
    const res = await call('browser_select', { selector: '#select' });
    assert.equal(res.result.isError, true);
    assert.match(resultText(res), /INVALID_ARGS/);
    assert.match(resultText(res), /one of/);
  });

  it('rejects when more than one criterion is provided', async () => {
    const res = await call('browser_select', {
      selector: '#select',
      value: 'option2',
      index: 1
    });
    assert.equal(res.result.isError, true);
    assert.match(resultText(res), /INVALID_ARGS/);
    assert.match(resultText(res), /exactly one/);
  });

  it('reports ELEMENT_NOT_FOUND for a missing selector', async () => {
    const res = await call('browser_select', {
      selector: '#does-not-exist',
      value: 'x',
      timeout_ms: 800
    });
    assert.equal(res.result.isError, true);
    assert.match(resultText(res), /ELEMENT_NOT_FOUND/);
  });

  it('never logs the selected value to stderr', async () => {
    const secret = 'sup3r-s3cret-select';
    // No option matches, so the value only ever appears in the error message of
    // the tool result — never in server logs. This mirrors the browser_type rule.
    await call('browser_select', { selector: '#select', value: secret });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(!state.stderr.includes(secret), 'selected value leaked to stderr!');
  });
});
