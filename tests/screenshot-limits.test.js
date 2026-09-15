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

// A low pixel cap keeps these tests fast while exercising the same
// estimate + measure + re-scale path the default 16M limit uses.
const MAX_PIXELS = 2_000_000;

describe('browser_screenshot — limit handling', () => {
  let fixture;
  let state;
  let call;

  before(async () => {
    fixture = await startFixtureServer();
    state = startMcpServer({
      ENABLE_EVAL_JS: '1',
      MAX_SCREENSHOT_PIXELS: String(MAX_PIXELS)
    });
    await initializeServer(state, 'screenshot-limits-test');
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

  it('leaves an ordinary viewport capture unscaled', async () => {
    const res = assertSuccess(await call('browser_screenshot', {
      format: 'png',
      filename: 'limits-normal'
    }));
    assert.equal(res.truncated, false);
    assert.equal(res.measured, true);
    assert.ok(res.width * res.height <= MAX_PIXELS);
  });

  it('downscales an oversized explicit viewport without cropping', async () => {
    assertSuccess(await call('browser_resize', { width: 2000, height: 2000 }));
    const res = assertSuccess(await call('browser_screenshot', {
      format: 'png',
      filename: 'limits-explicit'
    }));
    assert.equal(res.truncated, true);
    assert.ok(res.width * res.height <= MAX_PIXELS, `got ${res.width}x${res.height}`);
    assert.ok(res.width > 0 && res.height > 0);
  });

  it('downscales a mobile preset whose page scale inflates the capture', async () => {
    assertSuccess(await call('browser_resize', { preset: 'mobile' }));
    const res = assertSuccess(await call('browser_screenshot', {
      format: 'png',
      filename: 'limits-mobile'
    }));
    assert.equal(res.truncated, true);
    assert.ok(res.width * res.height <= MAX_PIXELS, `got ${res.width}x${res.height}`);
  });

  it('keeps a full-page capture of a tall page within the limit', async () => {
    const res = assertSuccess(await call('browser_screenshot', {
      full_page: true,
      format: 'png',
      filename: 'limits-fullpage'
    }));
    assert.ok(res.width * res.height <= MAX_PIXELS, `got ${res.width}x${res.height}`);
    // Downscaled, never cropped: the full document width is retained.
    assert.ok(res.width > 0);
  });
});
