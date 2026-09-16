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

describe('browser_resize', () => {
  let fixture;
  let state;
  let call;

  before(async () => {
    fixture = await startFixtureServer();
    // ENABLE_EVAL_JS lets the assertions read window.innerWidth/Height/devicePixelRatio.
    state = startMcpServer({ ENABLE_EVAL_JS: '1' });
    await initializeServer(state, 'resize-test');
    call = makeCallTool(state);
  });

  after(async () => {
    await stopServer(state);
    fixture.server.close();
  });

  beforeEach(async () => {
    await call('browser_resize', { reset: true });
    await navigateToTestPage(call, fixture.port);
  });

  async function dimensions() {
    const res = assertSuccess(await call('browser_evaluate', {
      expression: '({ iw: window.innerWidth, ih: window.innerHeight, ' +
        'vw: window.visualViewport.width, vh: window.visualViewport.height })'
    }));
    return res.result;
  }

  it('applies an explicit width and height', async () => {
    const res = assertSuccess(await call('browser_resize', { width: 500, height: 700 }));
    assert.equal(res.resized, true);
    assert.equal(res.width, 500);
    assert.equal(res.height, 700);
    assert.equal(res.preset, null);
    assert.equal(res.reset, false);

    const dims = await dimensions();
    assert.equal(dims.iw, 500);
    assert.equal(dims.ih, 700);
  });

  it('applies each preset with the documented values', async () => {
    // Mobile presets apply a page scale, so the layout viewport (innerWidth)
    // is scaled; the visual viewport reflects the requested size exactly.
    for (const [preset, w, h, isMobile] of [
      ['mobile', 390, 844, true],
      ['tablet', 768, 1024, true],
      ['desktop', 1280, 800, false]
    ]) {
      // Isolate each preset — a mobile page scale would otherwise carry over.
      await call('browser_resize', { reset: true });

      const res = assertSuccess(await call('browser_resize', { preset }));
      assert.equal(res.preset, preset);
      assert.equal(res.width, w);
      assert.equal(res.height, h);

      const dims = await dimensions();
      assert.equal(isMobile ? dims.vw : dims.iw, w, `preset ${preset} width`);
      assert.equal(isMobile ? dims.vh : dims.ih, h, `preset ${preset} height`);
    }
  });

  it('applies the device scale factor', async () => {
    assertSuccess(await call('browser_resize', {
      width: 400,
      height: 600,
      device_scale_factor: 2
    }));
    const dpr = assertSuccess(await call('browser_evaluate', {
      expression: 'window.devicePixelRatio'
    }));
    assert.equal(dpr.result, 2);
  });

  it('reset restores the default viewport', async () => {
    assertSuccess(await call('browser_resize', { width: 500, height: 700 }));
    const res = assertSuccess(await call('browser_resize', { reset: true }));
    assert.equal(res.reset, true);
    assert.ok(res.measured, 'reset reports the measured viewport too');

    const dims = await dimensions();
    assert.notEqual(dims.iw, 500);
  });

  it('reports the measured viewport alongside the requested one', async () => {
    const res = assertSuccess(await call('browser_resize', { width: 500, height: 700 }));
    assert.equal(res.width, 500, 'the requested width is echoed');
    assert.equal(res.measured.innerWidth, 500, 'the measured width is reported separately');
    assert.equal(res.measured.innerHeight, 700);
    assert.equal(res.warning, undefined, 'no warning when the page accepts the width');
  });

  it('warns when the page overflows the requested width', async () => {
    // tall-page.html is 3000px wide, so a 390px mobile viewport cannot hold it.
    await call('browser_navigate', { url: `http://127.0.0.1:${fixture.port}/tall-page.html` });
    const res = assertSuccess(await call('browser_resize', { preset: 'mobile' }));

    assert.equal(res.width, 390, 'the requested preset width is echoed');
    assert.notEqual(res.measured.innerWidth, 390, 'the page did not accept the requested width');
    assert.match(res.warning, /innerWidth/);
  });

  it('starts with a small default window so the first capture stays cheap', async () => {
    // beforeEach reset the emulation override and navigated, so this reads the
    // raw Chromium window size. It is deliberately NOT a desktop size: adding
    // --window-size=1440,900 made each software-rendered capture ~5x more
    // expensive (past 30s) and timed out the suite. Call browser_resize when a
    // desktop layout is needed. Update this bound only if capture cost improves.
    const dims = await dimensions();
    assert.ok(dims.iw <= 1000, `default window width inflated to ${dims.iw}`);
  });

  it('keeps the resize across a navigation', async () => {
    assertSuccess(await call('browser_resize', { width: 600, height: 720 }));
    await navigateToTestPage(call, fixture.port);

    const dims = await dimensions();
    assert.equal(dims.iw, 600);
    assert.equal(dims.ih, 720);
  });

  it('does not clear the resize after a full_page screenshot', async () => {
    assertSuccess(await call('browser_resize', { width: 640, height: 800 }));

    assertSuccess(await call('browser_screenshot', {
      full_page: true,
      format: 'png',
      filename: 'resize-regression'
    }));

    const dims = await dimensions();
    assert.equal(dims.iw, 640);
    assert.equal(dims.ih, 800);
  });

  it('rejects an empty call with INVALID_ARGS', async () => {
    const res = await call('browser_resize', {});
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /INVALID_ARGS/);
  });

  it('rejects reset combined with other options', async () => {
    const res = await call('browser_resize', { reset: true, width: 500, height: 700 });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /INVALID_ARGS/);
  });

  it('rejects width without height', async () => {
    const res = await call('browser_resize', { width: 500 });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /INVALID_ARGS/);
  });

  it('rejects an unknown preset', async () => {
    const res = await call('browser_resize', { preset: 'watch' });
    assert.equal(res.result.isError, true);
  });
});
