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

## Prerequisites

- Chromium must be installed. Set `CHROMIUM_PATH` env var if it is not at a standard location (`/usr/bin/chromium-browser`, `/usr/bin/chromium`, etc.).
- `./install-chromium.sh` installs a compatible build on Debian/Ubuntu (idempotent; `--dry-run` previews; `--uninstall` removes only the apt source/pin it created). Ubuntu ships `chromium-browser` as a snap-only transitional package (`2:1snap1-0ubuntu4`), which cannot work inside proot-distro — the script adds the Debian bookworm archive, APT-pinned so it can only satisfy `chromium`, `chromium-common`, and `chromium-sandbox`, and verified with `debian-archive-keyring` (`signed-by=`) instead of `trusted=yes`.
- Integration tests (`integration.test.js`, `interaction.test.js`, etc.) spawn real Chromium processes — they will fail without it.

## Architecture

- `index.js` — MCP server entrypoint; registers 9 tools (`browser_navigate`, `browser_get_text`, `browser_screenshot`, `browser_get_console`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_wait_for`, `browser_scroll`); operation lock serializes state-changing ops; idle timer + activity tracking; same-document (hash) navigation handled via `Page.navigatedWithinDocument`; full-page screenshots warm up lazy rendering and use an emulation viewport override with scale-factor downscaling
- `src/browser.js` — Chromium lifecycle: spawn, CDP port discovery via `DevToolsActivePort`, WebSocket connect, WS-reconnect (same process, backoff), crash auto-restart (new profile/port), process-group cleanup. Domains enabled: Page, Runtime, Network, DOM, Accessibility (Emulation needs no `enable` command)
- `src/cdp.js` — Raw CDP WebSocket client (EventEmitter-based, request/response correlation by ID)
- `src/helpers.js` — In-page interaction helpers executed via `Runtime.callFunctionOn` (static function strings; selectors/text always passed as CDP arguments, never concatenated)
- `src/lock.js` — Operation lock (FIFO mutex, queue limit `CONFIG.QUEUE_LIMIT`, `BUSY_QUEUE_FULL`)
- `src/console-buffer.js` — In-memory ring buffer for console messages
- `src/utils.js` — URL validation (rejects `file:`/`javascript:`/`data:`, blocks private IPs by default), path traversal checks, truncation helpers, env-driven limits

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
- All logging goes to stderr; stdout is reserved for MCP JSON-RPC.

## Security rules

- Selectors and typed text are passed to in-page helpers as CDP `arguments` values — NEVER concatenated into JavaScript source.
- `browser_type` never logs the typed text (may contain passwords/tokens).
- URL scheme whitelist (http/https/about), private-IP blocking (`ALLOW_PRIVATE_NETWORKS`), screenshot path traversal checks.

## Test conventions

- Tests use `node:test` with `node:assert/strict` — no external test framework.
- `fixtures/test-page.html` is the shared test fixture (also `fixtures/page2.html` for navigation tests).
- `npm test` uses `--test-concurrency=3`: 13+ files each spawn Chromium; full parallelism exhausts RAM on small devices.

## Documentation Rules

When the user asks to update, create, improve, or rewrite README.md,
you MUST load and follow the `readme-master` skill before doing anything else.
Do not write README.md without first completing Phase 1 (full project exploration).
