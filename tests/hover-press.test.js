import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startFixtureServer,
  startMcpServer,
  stopServer,
  initializeServer,
  makeCallTool,
  assertSuccess,
  getText,
  navigateToTestPage
} from './harness.js';

describe('browser_hover / browser_press', () => {
  let fixture;
  let state;
  let call;

  before(async () => {
    fixture = await startFixtureServer();
    state = startMcpServer({ ENABLE_EVAL_JS: '1' });
    await initializeServer(state, 'hover-press-test');
    call = makeCallTool(state);
  });

  after(async () => {
    await stopServer(state);
    fixture.server.close();
  });

  beforeEach(async () => {
    await navigateToTestPage(call, fixture.port);
  });

  describe('browser_hover', () => {
    it('hovers an element and enters the :hover state', async () => {
      const res = assertSuccess(await call('browser_hover', { selector: '#hover-target' }));
      assert.equal(res.hovered, true);
      assert.equal(res.selector, '#hover-target');
      assert.equal(typeof res.x, 'number');
      assert.equal(res.matchesHover, true);

      const hoverText = await getText(call, '#hover-result');
      assert.equal(hoverText, 'hovered');
    });

    it('reports ELEMENT_NOT_FOUND for a missing selector', async () => {
      const res = await call('browser_hover', { selector: '#does-not-exist', timeout_ms: 1000 });
      assert.equal(res.result.isError, true);
      assert.match(res.result.content[0].text, /ELEMENT_NOT_FOUND/);
    });

    it('reports ELEMENT_HIDDEN for a hidden element', async () => {
      const res = await call('browser_hover', { selector: '#hidden-btn', timeout_ms: 2000 });
      assert.equal(res.result.isError, true);
      assert.match(res.result.content[0].text, /ELEMENT_HIDDEN/);
    });
  });

  describe('browser_press', () => {
    it('submits a form when Enter is pressed in an input', async () => {
      assertSuccess(await call('browser_type', {
        selector: '#form-input',
        text: 'hello'
      }));

      const res = assertSuccess(await call('browser_press', {
        key: 'Enter',
        selector: '#form-input'
      }));
      assert.equal(res.pressed, true);
      assert.equal(res.focused, true);

      const result = await getText(call, '#click-result');
      assert.match(result, /Form submitted: hello/);
    });

    it('moves focus on Tab', async () => {
      assertSuccess(await call('browser_press', { key: 'Tab' }));
      const active = assertSuccess(await call('browser_evaluate', {
        expression: 'document.activeElement.tagName'
      }));
      assert.notEqual(active.result, 'BODY');
    });

    it('reports Escape through the keydown listener', async () => {
      assertSuccess(await call('browser_press', { key: 'Escape' }));
      const keyResult = await getText(call, '#key-result');
      assert.match(keyResult, /key=Escape/);
    });

    it('applies modifiers', async () => {
      assertSuccess(await call('browser_press', {
        key: 'a',
        modifiers: ['Control'],
        selector: '#form-input'
      }));
      const keyResult = await getText(call, '#key-result');
      assert.match(keyResult, /key=a/);
      assert.match(keyResult, /ctrl=true/);
    });

    it('focuses the target when a selector is given', async () => {
      const res = assertSuccess(await call('browser_press', {
        key: 'ArrowDown',
        selector: '#form-input'
      }));
      assert.equal(res.focused, true);
      assert.equal(res.key, 'ArrowDown');
    });

    it('rejects an unsupported key with KEY_NOT_SUPPORTED', async () => {
      const res = await call('browser_press', { key: 'MadeUpKey' });
      assert.equal(res.result.isError, true);
      assert.match(res.result.content[0].text, /KEY_NOT_SUPPORTED/);
    });

    it('reports ELEMENT_NOT_FOUND for a missing selector', async () => {
      const res = await call('browser_press', {
        key: 'Enter',
        selector: '#does-not-exist',
        timeout_ms: 1000
      });
      assert.equal(res.result.isError, true);
      assert.match(res.result.content[0].text, /ELEMENT_NOT_FOUND/);
    });
  });
});
