// tests/fixture-pages.test.js
// ---------------------------------------------------------------------------
// Coverage for the three purpose-built fixtures:
//
//   fixtures/scroll-resize-page.html  - browser_scroll semantics + browser_resize
//   fixtures/form-keys-page.html      - press/type/wait_for/snapshot roles
//   fixtures/console-motion-page.html - get_console levels, canvas sizes, frames
//
// Uses the shared harness. ENABLE_EVAL_JS=1 is set so focus/visibility can be
// asserted directly (read-only probes cannot report activeElement or display).
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

describe('fixture pages — scroll, resize, keys, console, canvas, frames', () => {
  let fixture;
  let mcp;
  let call;
  let origin;

  before(async () => {
    fixture = await startFixtureServer();
    origin = `http://127.0.0.1:${fixture.port}`;
    mcp = startMcpServer({
      ENABLE_EVAL_JS: '1',
      OUTPUT_DIR: `/tmp/fixture-pages-${process.pid}`,
    });
    await initializeServer(mcp, 'fixture-pages-test');
    call = makeCallTool(mcp);
  });

  after(async () => {
    await stopServer(mcp);
    fixture.server.close();
  });

  describe('scroll-resize-page.html', () => {
    it('scrolls by direction and preserves the untouched axis', async () => {
      assertSuccess(await call('browser_navigate', { url: `${origin}/scroll-resize-page.html` }, 60000));
      assertSuccess(await call('browser_resize', { width: 600, height: 600 }));

      const down = assertSuccess(await call('browser_scroll', { direction: 'down' }));
      assert.ok(down.scrollY > 0, `expected scrollY > 0, got ${down.scrollY}`);

      // Horizontal scroll, then a single-axis vertical scroll must keep X.
      const right = assertSuccess(await call('browser_scroll', { x: 400 }));
      assert.equal(right.scrollX, 400);
      const keepX = assertSuccess(await call('browser_scroll', { y: 100 }));
      assert.equal(keepX.scrollX, 400);
      assert.equal(keepX.scrollY, 100);
    });

    it('distinguishes partially visible from fully visible elements', async () => {
      const tall = assertSuccess(await call('browser_scroll', { selector: '#tall-element' }));
      assert.equal(tall.inViewport, true);
      assert.equal(tall.fullyInViewport, false, 'a 2500px element never fits the viewport');

      const small = assertSuccess(await call('browser_scroll', { selector: '#small-box' }));
      assert.equal(small.inViewport, true);
      assert.equal(small.fullyInViewport, true);
    });

    it('reports measured viewport and warns on horizontal overflow', async () => {
      const res = assertSuccess(await call('browser_resize', { width: 500, height: 700 }));
      assert.equal(res.width, 500);
      assert.ok(res.measured, 'measured values must be present');
      assert.equal(res.measured.innerWidth, 500, 'the measured width is reported separately');
      assert.equal(res.measured.innerHeight, 700);
      // The 2000px strip overflows: scrollWidth proves it even though the
      // window itself still reports the requested width (no shrink-to-fit
      // outside mobile emulation — see the mobile case below).
      assert.ok(res.measured.scrollWidth > 500, `expected overflow, got ${res.measured.scrollWidth}`);

      // tall-page.html is 3000px wide, so a 390px mobile viewport cannot hold
      // it — this is the documented warning path (same as resize.test.js).
      assertSuccess(await call('browser_navigate', { url: `${origin}/tall-page.html` }, 60000));
      const mobile = assertSuccess(await call('browser_resize', { preset: 'mobile' }));
      assert.equal(mobile.width, 390);
      assert.notEqual(mobile.measured.innerWidth, 390);
      assert.match(mobile.warning, /innerWidth/);
      assertSuccess(await call('browser_resize', { reset: true }));
      assertSuccess(await call('browser_navigate', { url: `${origin}/scroll-resize-page.html` }, 60000));
    });

    it('reflects a same-document hash navigation in get_url', async () => {
      assertSuccess(await call('browser_navigate', { url: `${origin}/scroll-resize-page.html#sec-b` }, 60000));
      const info = assertSuccess(await call('browser_get_url'));
      assert.ok(info.url.endsWith('#sec-b'), `expected hash url, got ${info.url}`);
    });
  });

  describe('form-keys-page.html', () => {
    it('types into password and contenteditable, then submits with Enter', async () => {
      assertSuccess(await call('browser_navigate', { url: `${origin}/form-keys-page.html` }, 60000));
      assertSuccess(await call('browser_type', { selector: '#name-input', text: 'Layla' }));

      const pwd = assertSuccess(
        await call('browser_type', { selector: '#pwd-input', text: 's3cret!' }),
      );
      assert.ok(pwd.finalLength > 0);

      const back = assertSuccess(await call('browser_get_text', { selector: '#pwd-input' }));
      assert.equal(back.text, 's3cret!');

      const ed = assertSuccess(
        await call('browser_type', { selector: '#editor', text: 'hello notes' }),
      );
      assert.ok(ed.finalLength > 0);

      assertSuccess(await call('browser_press', { key: 'Enter', selector: '#name-input' }));
      const submitted = assertSuccess(await call('browser_get_text', { selector: '#submit-result' }));
      assert.match(submitted.text, /Form submitted: Layla/);
    });

    it('moves focus with Tab, reports modifiers, and closes the modal with Escape', async () => {
      // Focus starts in the name input; Tab must advance it to the password input.
      assertSuccess(await call('browser_click', { selector: '#name-input' }));
      assertSuccess(await call('browser_press', { key: 'Tab' }));
      const active = assertSuccess(
        await call('browser_evaluate', { expression: 'document.activeElement.id' }),
      );
      assert.equal(active.result, 'pwd-input');

      assertSuccess(await call('browser_press', { key: 'a', modifiers: ['Control'] }));
      const keys = assertSuccess(await call('browser_get_text', { selector: '#key-result' }));
      assert.match(keys.text, /ctrl=true/);

      assertSuccess(await call('browser_click', { selector: '#open-modal-btn' }));
      const shown = assertSuccess(
        await call('browser_evaluate', {
          expression: "getComputedStyle(document.getElementById('modal')).display",
        }),
      );
      assert.notEqual(shown.result, 'none');

      assertSuccess(await call('browser_press', { key: 'Escape' }));
      const hidden = assertSuccess(
        await call('browser_evaluate', {
          expression: "getComputedStyle(document.getElementById('modal')).display",
        }),
      );
      assert.equal(hidden.result, 'none');
    });

    it('waits for async text and snapshots the role vocabulary', async () => {
      const found = assertSuccess(
        await call('browser_wait_for', { text: 'READY-123', timeout_ms: 10000 }, 30000),
      );
      assert.equal(found.found, true);

      const snap = assertSuccess(await call('browser_snapshot', { max_items: 100 }));
      const roles = new Set(snap.elements.map((e) => e.role));
      for (const role of ['button', 'link', 'textbox', 'checkbox', 'radio', 'switch', 'slider', 'tab', 'searchbox', 'combobox']) {
        assert.ok(roles.has(role), `expected role "${role}" in snapshot, got ${[...roles]}`);
      }
    });

    it('rejects an unknown key and an invalid scroll combination', async () => {
      const badKey = await call('browser_press', { key: 'MadeUpKey' });
      assert.equal(badKey.result.isError, true);
      assert.match(resultText(badKey), /KEY_NOT_SUPPORTED/);

      const badScroll = await call('browser_scroll', {});
      assert.equal(badScroll.result.isError, true);
      assert.match(resultText(badScroll), /INVALID_ARGS/);
    });
  });

  describe('console-motion-page.html', () => {
    it('buffers every console level plus the uncaught exception', async () => {
      assertSuccess(await call('browser_navigate', { url: `${origin}/console-motion-page.html` }, 60000));
      await new Promise((r) => setTimeout(r, 1200)); // let the 500ms throw fire

      const all = assertSuccess(await call('browser_get_console', { level: 'all' }));
      const levels = new Set(all.messages.map((m) => m.level));
      for (const level of ['log', 'info', 'warning', 'error', 'debug']) {
        assert.ok(levels.has(level), `expected level "${level}", got ${[...levels]}`);
      }
      assert.ok(
        all.messages.some((m) => m.text.includes('boom-uncaught-motion-fixture')),
        'the uncaught exception must be recorded as an error',
      );

      const errors = assertSuccess(await call('browser_get_console', { level: 'error' }));
      assert.ok(errors.messages.length > 0);
      assert.ok(errors.messages.every((m) => m.level === 'error'));

      const cleared = assertSuccess(
        await call('browser_get_console', { level: 'all', clear_after: true }),
      );
      assert.equal(cleared.cleared, true);
      assert.equal(assertSuccess(await call('browser_get_console')).count, 0);
    });

    it('describes drawn, blank, and CSS-resized canvases', async () => {
      const report = assertSuccess(await call('browser_canvas_info', { max_canvases: 10 }));
      assert.equal(report.count, 3);

      const drawn = report.canvases.find((c) => c.id === 'drawn-canvas');
      const blank = report.canvases.find((c) => c.id === 'blank-canvas');
      const sized = report.canvases.find((c) => c.id === 'sized-canvas');
      assert.ok(drawn && blank && sized);

      assert.equal(drawn.pixels.blank, false);
      assert.match(drawn.verdict, /pixel content/i);
      assert.equal(blank.pixels.blank, true);

      assert.deepEqual(sized.attributeSize, { width: 100, height: 100 });
      // getBoundingClientRect includes the 1px border: 300x50 CSS + 2px.
      // Assert the shape (CSS-resized, not attribute-sized), not exact pixels.
      assert.ok(Math.abs(sized.cssSize.width - 300) <= 4, `css width ~300, got ${sized.cssSize.width}`);
      assert.ok(Math.abs(sized.cssSize.height - 50) <= 4, `css height ~50, got ${sized.cssSize.height}`);
      assert.notDeepEqual(sized.cssSize, sized.attributeSize);
    });

    it('captures a frame sequence clipped to an element', async () => {
      const result = assertSuccess(
        await call(
          'browser_capture_frames',
          { count: 2, strategy: 'poll', interval_ms: 80, selector: '#clip-target' },
          60000,
        ),
      );
      assert.equal(result.captured, 2);
      assert.ok(result.clip.width > 0 && result.clip.height > 0);
      for (const frame of result.frames) {
        assert.ok(frame.size > 0);
        assert.ok(frame.width > 0 && frame.height > 0);
      }
    });
  });
});
