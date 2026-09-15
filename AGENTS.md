# AGENTS.md

## Project

`browser-mcp` — MCP server for headless Chromium browser automation via raw CDP (no Puppeteer/Playwright). ESM (`"type": "module"`), Node.js.

## Commands

```bash
npm test                            # run all tests (node:test, concurrency 3 — bounded Chromium on low-RAM devices)
node --test tests/interaction.test.js   # run a single test file
node index.js                       # start the MCP server (stdio transport)
./install-chromium.sh               # install Chromium (Debian/Ubuntu; idempotent, --dry-run to preview)
```

No lint, typecheck, or build step exists.

> **Low-RAM devices:** `npm test` in one shot can exhaust RAM (each file spawns Chromium; `memory.test.js` runs 50 start/stop cycles) and the OOM killer may take down the whole process/session. Prefer running files one at a time with `node --test --test-concurrency=1 tests/<file>.test.js`, and run `memory.test.js` alone and last.

## Prerequisites

- Chromium must be installed. Set `CHROMIUM_PATH` env var if it is not at a standard location (`/usr/bin/chromium-browser`, `/usr/bin/chromium`, etc.).
- `./install-chromium.sh` installs a compatible build on Debian/Ubuntu (idempotent; `--dry-run` previews; `--uninstall` removes only the apt source/pin it created). Ubuntu ships `chromium-browser` as a snap-only transitional package (`2:1snap1-0ubuntu4`), which cannot work inside proot-distro — the script adds the Debian bookworm archive, APT-pinned so it can only satisfy `chromium`, `chromium-common`, and `chromium-sandbox`, and verified with `debian-archive-keyring` (`signed-by=`) instead of `trusted=yes`.
- Integration tests (`integration.test.js`, `interaction.test.js`, etc.) spawn real Chromium processes — they will fail without it.

## Architecture

- `index.js` — MCP server entrypoint; registers 13 tools (`browser_navigate`, `browser_get_text`, `browser_screenshot`, `browser_get_console`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_wait_for`, `browser_scroll`, `browser_resize`, `browser_evaluate`, `browser_hover`, `browser_press`); operation lock serializes state-changing ops; idle timer + activity tracking; same-document (hash) navigation handled via `Page.navigatedWithinDocument`; full-page screenshots warm up lazy rendering and use an emulation viewport override with scale-factor downscaling
- `src/browser.js` — Chromium lifecycle: spawn, CDP port discovery via `DevToolsActivePort`, WebSocket connect, WS-reconnect (same process, backoff), crash auto-restart (new profile/port), process-group cleanup; holds the persistent `viewport` override and re-applies it in `_connectToPage`. Domains enabled: Page, Runtime, Network, DOM, Accessibility (Emulation needs no `enable` command)
- `src/cdp.js` — Raw CDP WebSocket client (EventEmitter-based, request/response correlation by ID)
- `src/helpers.js` — In-page interaction helpers executed via `Runtime.callFunctionOn` (static function strings; selectors/text always passed as CDP arguments, never concatenated)
- `src/viewport.js` — Viewport presets + `resolveViewportParams` (validates RAW resize args, not Zod-normalized ones)
- `src/keymap.js` — `resolveKey`: named keys + single characters → `{ key, code, keyCode, text, modifiers }` for `browser_press`
- `src/lock.js` — Operation lock (FIFO mutex, queue limit `CONFIG.QUEUE_LIMIT`, `BUSY_QUEUE_FULL`)
- `src/console-buffer.js` — In-memory ring buffer for console messages
- `src/utils.js` — URL validation (rejects `file:`/`javascript:`/`data:`, blocks private IPs by default), path traversal checks, truncation helpers, `isEvalJsEnabled`, `decodeImageSize` (PNG/JPEG header decode), env-driven limits

## Key behaviors

- Browser starts **lazily** on first tool call, not at server startup.
- Screenshots write to `./screenshots/` (override with `OUTPUT_DIR` env var). Paths are validated against traversal. `delay_ms` (0–5000) delays capture for animated pages.
- Full-page screenshots (`full_page: true`) scroll the whole page first (triggering IntersectionObserver/lazy rendering), set a temporary full-height viewport via `Emulation.setDeviceMetricsOverride` (always reset afterwards), and downscale oversized pages via `clip.scale` — never by cropping the capture area.
- Viewport screenshots (`full_page: false`) pass NO `clip` to `Page.captureScreenshot` — an explicit clip with `captureBeyondViewport: false` captures a blank (white/black) frame on scrolled pages (clip coordinates are page-space; Chromium never produces the clipped surface). Without a clip, the current viewport at the current scroll position is captured correctly.
- Idle shutdown after 5 min (override with `IDLE_SHUTDOWN_MS`; `0` disables). Idle never interrupts an in-flight tool call.
- Console buffer clears on each main-frame navigation.
- Same-document (hash-only) navigations are handled via `Page.navigatedWithinDocument` — they do NOT wait for `Page.loadEventFired`, and the handler settles ~200ms + double-rAF after the anchor scroll so the next screenshot is not a blank frame.
- `browser_get_text` reads `el.value` for form elements (`input`/`textarea`/`select`) — typed/selected content is in the `value` property, not text nodes (`innerText` would return empty). Non-form elements use `innerText` as before.
- `browser_click` uses real mouse events (`Input.dispatchMouseEvent`), multi-point hit testing (center + 4 quadrants), and a `force: true` option that falls back to JS `.click()` for overlay-covered elements (returns `forced: true`). Before the coverage check it scrolls the element into view with `behavior: 'instant'`, waits ~100ms + double-rAF for the compositor, and re-reads the clickable point once if the first read reports the element covered (below-viewport / sticky-header layouts).
- `browser_scroll` scrolls by direction / to element / to absolute coordinates, with `behavior: 'instant'` (no animation). Every scroll runner waits ~100ms + double-rAF (compositor settle) before returning, so a screenshot in the next tool call is not a blank frame.
- `browser_resize` applies a persistent viewport override via `Emulation.setDeviceMetricsOverride` (presets: mobile `390×844 @3`, tablet `768×1024 @2`, desktop `1280×800 @1`, or explicit `width`+`height`, or `reset`). The override is stored on `Browser.viewport`, survives idle shutdown, and is re-applied automatically after a restart/reconnect. A full-page screenshot restores the previous viewport in a `finally` block instead of clearing it.
- `browser_evaluate` is **disabled by default** and refused with `[EVAL_DISABLED]` before the browser starts unless `ENABLE_EVAL_JS=1`. Results are serialized in-page by the static `IN_PAGE.serializeValue` (cycles handled; DOM/Function/Date/Error/Map/Set/BigInt readable) and truncated to `MAX_EVAL_LENGTH`. The remote object handle is always released.
- `browser_hover` moves the real mouse to an unobstructed point (center + quadrants), nudges (away/back) if `:hover` does not engage, and reports `matchesHover` (diagnostic). `browser_press` resolves keys via `src/keymap.js`; Enter/Tab/Space carry text so default actions (form submit, focus traversal) fire; a single-character key is logged as `<char>`.
- Screenshot limits are enforced by **post-capture measurement**: the real PNG/JPEG dimensions are decoded from the buffer (`decodeImageSize`) and the byte size checked; oversized captures are downscaled via `clip.scale` (never cropped) and re-captured at most once, else `[SCREENSHOT_TOO_LARGE]`. `mobile: true` page scale is caught this way because the pre-capture estimate can under-count.
- All logging goes to stderr; stdout is reserved for MCP JSON-RPC.

## Security rules

- Selectors and typed text are passed to in-page helpers as CDP `arguments` values — NEVER concatenated into JavaScript source.
- `browser_type` never logs the typed text (may contain passwords/tokens); `browser_press` logs a single-character key as `<char>`.
- `browser_evaluate` is gated behind `ENABLE_EVAL_JS` (off by default); when on it can read page data and reach internal networks via `fetch()` (SSRF).
- URL scheme whitelist (http/https/about), private-IP blocking (`ALLOW_PRIVATE_NETWORKS`), screenshot path traversal checks.

## Test conventions

- Tests use `node:test` with `node:assert/strict` — no external test framework.
- `fixtures/test-page.html` is the shared test fixture (also `fixtures/page2.html` for navigation tests).
- `tests/harness.js` holds the shared integration harness (fixture server, MCP child process, buffered JSON-RPC, `assertSuccess`/`getText`). Responses are reassembled across stdout chunks, so large inline screenshot payloads resolve.
- `npm test` uses `--test-concurrency=3`: 13+ files each spawn Chromium; full parallelism exhausts RAM on small devices.

## Documentation Rules

When the user asks to update, create, improve, or rewrite README.md,
you MUST load and follow the `readme-master` skill before doing anything else.
Do not write README.md without first completing Phase 1 (full project exploration).
