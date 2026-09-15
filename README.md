<!-- Badges: verified against package.json, node --version, and the Chromium binary. -->
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-brightgreen?logo=nodedotjs&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio%20JSON--RPC-blue)
![Chromium](https://img.shields.io/badge/Chromium-150.0.7871.100-4285F4?logo=googlechrome&logoColor=white)
![Platform](https://img.shields.io/badge/platform-aarch64%20%C2%B7%20x86__64-lightgrey)
![Tests](https://img.shields.io/badge/tests-258%20(node%3Atest)-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

# browser-mcp

> An MCP server that lets AI assistants drive headless Chromium over raw CDP — navigate, read, screenshot, click, type, and scroll — with no Puppeteer or Playwright dependency.

[What It Does](#what-it-does) · [Key Features](#key-features) · [Architecture](#architecture) · [Project Structure](#project-structure) · [Quick Start](#quick-start) · [Configuration](#configuration) · [API Reference](#api-reference) · [Security](#security) · [Testing and Quality](#testing-and-quality) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing)

---

## What It Does

`browser-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives an AI client — Codex CLI, Claude Code, opencode, or any MCP-capable host — a real browser it can read from and interact with. It implements the protocol over stdio and controls headless Chromium directly through the Chrome DevTools Protocol (CDP) WebSocket, so there is no Puppeteer/Playwright layer to install, pin, or fight with.

The server exposes thirteen tools: `browser_navigate`, `browser_get_text`, `browser_screenshot`, `browser_get_console`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_wait_for`, `browser_scroll`, `browser_resize`, `browser_evaluate`, `browser_hover`, and `browser_press`. Together they cover the common agent loop — open a page, snapshot the interactive elements, resize the viewport, click and type, hover and press keys, wait for state to change, evaluate page JavaScript, and capture the result as an image or text.

It is built for resource-constrained and ARM64 environments. Chromium launches lazily on the first tool call, shuts itself down after an idle period, and cleans up its process group and temporary profile so repeated start/stop cycles leak neither memory nor browser processes. State-changing operations are serialized behind a single lock, and reading operations wait for any in-flight navigation, so concurrent tool calls cannot race the page.

Use it when you want browser automation available to an AI assistant without bundling a heavyweight automation framework, or when you need it to run on aarch64 (for example inside a proot-distro container on Android/Termux). Its distinguishing trait is the deliberately thin stack: it speaks CDP itself, and it hardens the sharp edges (blank screenshots, stale frames, hash-only navigation, modal dialogs, overlay-covered clicks) that a raw CDP integration usually runs into.

---

## Key Features

- **Thirteen browser tools over MCP stdio** — navigation, text extraction, screenshots, console capture, accessibility snapshots, clicks, typing, waiting, scrolling, viewport resizing, JavaScript evaluation, hovering, and key presses.
- **Raw CDP, zero browser-framework dependencies** — only `@modelcontextprotocol/sdk`, `ws`, and `zod`; no Puppeteer or Playwright.
- **ARM64-native** — developed and verified on aarch64 (see [Tested Versions](#tested-versions)).
- **Lazy browser start** — Chromium launches on the first tool call, not at server startup.
- **Idle shutdown** — the browser stops after inactivity (default 5 min) while the MCP server stays alive and restarts it on demand. Idle never interrupts an in-flight tool call, and any new request extends the window.
- **Crash recovery** — automatic WebSocket reconnect to the same process (exponential backoff) and full Chromium restart on crash (up to 2 attempts). A `browser_resize` viewport override is re-applied automatically after a restart.
- **Operation lock** — state-changing operations are serialized; the FIFO queue is capped at `QUEUE_LIMIT` (8) and rejects with `BUSY_QUEUE_FULL`, with a 5-minute watchdog backstop.
- **Navigation race guard** — reading tools wait for any in-flight navigation before touching the page.
- **Persistent viewport control** — `browser_resize` applies mobile/tablet/desktop presets or explicit sizes; the override survives navigation, idle shutdown, and a full-page screenshot (restored, never silently cleared).
- **Measured screenshot limits** — the real PNG/JPEG dimensions are decoded from the captured buffer and the byte size checked; oversized captures are downscaled via `clip.scale` (never cropped) and re-captured once, catching `mobile: true` page-scale inflation the pre-capture estimate misses.
- **Gated JavaScript evaluation** — `browser_evaluate` is disabled by default and refused with `EVAL_DISABLED` unless `ENABLE_EVAL_JS=1`; results are serialized in-page (cycles, DOM, functions, Map/Set, BigInt) and truncated to `MAX_EVAL_LENGTH`.
- **Keyboard and hover control** — `browser_press` resolves named keys and characters (`src/keymap.js`) and fires default actions (form submit, focus traversal); `browser_hover` moves the real mouse and reports `matchesHover`.
- **Reliable full-page screenshots** — scrolls the page to trigger lazy/IntersectionObserver rendering, temporarily matches the viewport to the page height, and downscales oversized pages via `clip.scale` instead of cropping them.
- **Same-document navigation handling** — hash-only URL changes are detected and handled via `Page.navigatedWithinDocument`, so they never wait for a load event that never fires.
- **Modal dialog auto-dismiss** — `alert`/`confirm`/`prompt` dialogs are dismissed automatically so automation never hangs.
- **Injection-proof interaction** — CSS selectors and typed text travel as CDP `arguments` values, never concatenated into JavaScript source; typed text is never logged.
- **No leaked processes** — SIGTERM, idle shutdown, and stdin close all clean up Chromium plus its temporary profile, killing orphaned children first.

---

## Architecture

`browser-mcp` is a thin, layered MCP server. The protocol layer receives tool calls, an orchestration layer serializes and tracks them, a service layer drives Chromium through a CDP client and in-page helpers, and an infrastructure layer owns the browser process, its profile, and on-disk screenshot output.

```
        AI client (Codex CLI · Claude Code · opencode · any MCP host)
                                   │
                                   │  MCP over stdio (JSON-RPC)
                                   ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  Protocol / Interface       index.js                          │
  │  MCP server · 13 tool handlers · result + image content       │
  └───────────────────────────────┬───────────────────────────────┘
                                  ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  Orchestration          index.js · src/lock.js                │
  │  Operation lock · idle timer · activity tracking · nav guard  │
  └───────────────────────────────┬───────────────────────────────┘
                                  ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  Service / Engine                                             │
  │  src/browser.js · src/cdp.js · src/helpers.js                 │
  │  src/console-buffer.js · src/utils.js                         │
  └───────────────────────────────┬───────────────────────────────┘
                                  ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  Infrastructure                                               │
  │  headless Chromium process · CDP WebSocket · temp profile     │
  │  screenshots/ (OUTPUT_DIR) · stderr logging                   │
  └───────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer | Responsibility | Key Components |
|-------|---------------|----------------|
| Protocol / Interface | Speak MCP over stdio and expose the thirteen tools | `index.js` (`McpServer`, `StdioServerTransport`, tool registrations) |
| Orchestration | Serialize state-changing work, track activity, coordinate navigation, shut down when idle | `OperationLock` / `withLock`, `withActivityTracking`, `resetIdleTimer`, `navigationPromise`, `ensureBrowserReady` |
| Service / Engine | Drive Chromium, correlate CDP traffic, run in-page helpers, buffer console output, validate input | `Browser`, `CDPClient`, `helpers.js` runners + `IN_PAGE` functions, `ConsoleBuffer`, `utils.js` |
| Infrastructure | Own the browser process, WebSocket, temp profile, screenshot files, and versioned diagnostics | Chromium child process, `DevToolsActivePort`, profile dir under `tmpdir()`, `OUTPUT_DIR`, stderr |

### Design decisions worth knowing

- **No `Page.loadEventFired` for hash navigations.** The navigate handler compares origin/pathname/search before navigating; a hash-only change is awaited on `Page.navigatedWithinDocument` with a ~200 ms + double-rAF settle so the next screenshot is not blank (`index.js`).
- **Viewport screenshots pass no `clip`.** A clip with `captureBeyondViewport: false` yields a blank frame on scrolled pages because clip coordinates are page-space; omitting the clip captures the current viewport correctly.
- **Full-page screenshots change emulation state**, so they run behind the operation lock and always reset `Emulation.clearDeviceMetricsOverride` in a `finally` block.
- **Helpers are static strings.** `Runtime.callFunctionOn` receives fixed function declarations; selectors and text are separate `arguments` entries (`src/helpers.js`).
- **Cleanup kills the process group by profile path.** Orphaned Chromium children carry `--user-data-dir=<profile>` in their cmdline; `cleanup()` scans `/proc`, kills them, then removes the profile with retries (`src/browser.js`).

---

## Project Structure

```
browser-mcp/
├── index.js                  # MCP server entry point: 13 tool registrations, lock, idle timer
├── src/
│   ├── browser.js            # Chromium lifecycle: spawn, CDP connect, reconnect, restart, cleanup
│   ├── cdp.js                # Raw CDP WebSocket client (request/response correlation, events)
│   ├── helpers.js            # In-page helpers (IN_PAGE) + node-side runners (click/type/wait/scroll/hover/press/evaluate)
│   ├── keymap.js             # Key resolution for browser_press (named keys + characters)
│   ├── viewport.js           # Viewport presets + raw resize-argument validation
│   ├── lock.js               # FIFO operation lock with queue limit and watchdog release
│   ├── console-buffer.js     # In-memory ring buffer for console messages
│   └── utils.js              # URL/path validation, truncation, decodeImageSize, isEvalJsEnabled, CONFIG
├── tests/                    # 258 tests across 22 files (node:test + node:assert/strict)
│   ├── harness.js            # Shared harness: fixture server, MCP child, buffered JSON-RPC
│   ├── utils.test.js         # Validation, truncation, limits, image-size decode, eval gate
│   ├── viewport.test.js      # viewport.js presets and raw-argument validation
│   ├── keymap.test.js        # Key resolution and modifier bitmasks
│   ├── cdp.test.js           # Request/response correlation, pending cleanup
│   ├── lock.test.js          # FIFO ordering, queue limit, release-on-error
│   ├── helpers.test.js       # In-page helper security and unit tests
│   ├── browser.test.js       # Lifecycle: launch, crash, restart, cleanup
│   ├── reconnect.test.js     # WebSocket drop → reconnect to the same process
│   ├── restart.test.js       # Chromium crash → new process
│   ├── lazy-start.test.js    # Browser starts only on first tool call
│   ├── idle-shutdown.test.js # Idle timeout behavior
│   ├── mcp-handshake.test.js # MCP protocol handshake
│   ├── integration.test.js   # End-to-end navigation/reading
│   ├── reading-tools.test.js # get_text / get_console / snapshot
│   ├── interaction.test.js   # click / type / wait_for / scroll
│   ├── resize.test.js        # resize: explicit/presets/reset, persistence, full_page survival
│   ├── evaluate.test.js      # evaluate: gate, primitives, DOM, cycles, promises, exceptions
│   ├── hover-press.test.js   # hover and key press (Enter/Tab/Escape/modifiers)
│   ├── screenshot-limits.test.js # Post-capture downscaling and limit enforcement
│   ├── parallel.test.js      # Concurrent instances and lock serialization
│   ├── memory.test.js        # Truncation and memory-bound behavior
│   └── cleanup.test.js       # Process and profile cleanup, no leaks
├── fixtures/                 # Test HTML pages
│   ├── test-page.html        # Shared interactive fixture
│   ├── page2.html            # Navigation target
│   ├── lazy-page.html        # Lazy/IntersectionObserver rendering
│   └── tall-page.html        # Full-page screenshot fixture
├── screenshots/              # Screenshot output directory (runtime, override with OUTPUT_DIR)
├── stress-test.sh            # Start/stop cycles: Chromium leak + RSS growth check
├── install-chromium.sh       # Installs Chromium (Debian archive on Ubuntu, APT-pinned)
├── .env.example              # Reference for every environment variable (not auto-loaded)
├── AGENTS.md                 # Agent-facing project guide
├── ARCHITECTURE.md           # Deeper architecture and call-graph reference
├── opencode.json             # opencode project config
├── package.json              # Metadata and the `npm test` script
└── README.md
```

---

## Quick Start

### Prerequisites

- **Node.js ≥ 20** (verified on v26.2.0) and **npm** (verified on 11.13.0)
- **Chromium or Google Chrome** (verified on Chromium 150.0.7871.100), auto-detected at `/usr/bin/chromium-browser`, `/usr/bin/chromium`, `/usr/bin/google-chrome`, or `/usr/bin/google-chrome-stable` — otherwise set `CHROMIUM_PATH`. On Debian/Ubuntu, [Install Chromium](#install-chromium) does this for you.
- **Architecture**: aarch64 (ARM64) verified; x86_64 should work identically
- Android/Termux users: the project was developed inside a **proot-distro** Ubuntu 26.04 container
- No API keys or external services are required — the server is entirely local

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/amjdcodes/browser-mcp.git
cd browser-mcp

# 2. Install dependencies
npm ci

# 3. Verify Chromium is reachable
chromium --version        # or: CHROMIUM_PATH=/path/to/chromium node index.js
```

### Install Chromium

If Chromium is not already installed, the bundled script installs a compatible build:

```bash
./install-chromium.sh --dry-run   # show the plan, change nothing
sudo ./install-chromium.sh        # install (prompts once; --yes to skip)
```

**What it does on Ubuntu.** Ubuntu does not ship a real Chromium `.deb`: `chromium-browser` is a transitional package that installs the Chromium *snap* (`2:1snap1-0ubuntu4`, `Provides: chromium`), and snap is unavailable inside proot-distro containers. The script therefore adds the **Debian bookworm** archive (`deb.debian.org/debian bookworm main`) to supply the `.deb`, reproducing the environment this server is verified against (Chromium 150.0.7871.100, `chromium-common`, `chromium-sandbox`). Two safeguards keep that archive from disturbing the rest of the system:

- **APT pinning** — the Debian archive may only satisfy `chromium`, `chromium-common`, and `chromium-sandbox` (priority `500`). Every other package from it stays at priority `100`, so it can never override an Ubuntu package.
- **Signature verification** — the archive is verified with `debian-archive-keyring` (`signed-by=…`) rather than the unverified `trusted=yes`.

The script is idempotent: if a working Chromium already exists it reports the path and exits without touching any system configuration. It also verifies the result itself by running Chromium headless with the same flags the server uses — not just `chromium --version`.

```bash
chromium --version                                       # Chromium 150.0.7871.100 (...)
chromium --headless --no-sandbox --dump-dom about:blank  # must exit 0
```

`sudo ./install-chromium.sh --uninstall` removes only the apt source and pin this script created — a pre-existing Debian archive and the installed packages are left in place.

On other distributions, install Chromium with the native package manager (`dnf`, `pacman`, `zypper`, `apk`, `brew`) and let the server auto-detect it; the script prints the exact commands.

### Run the server

```bash
node index.js
```

All logs go to **stderr**; stdout is reserved for MCP JSON-RPC. The browser does not start until the first tool call.

### Register with an MCP client

The examples below use `$(pwd)` so they work from any checkout location. Substitute the binary path for your Chromium install if it is not auto-detected.

**Codex CLI:**

```bash
codex mcp add browser \
  --env OUTPUT_DIR="$(pwd)/screenshots" \
  --env CHROMIUM_PATH=/usr/bin/chromium \
  -- node "$(pwd)/index.js"
codex mcp list          # verify
```

**Claude Code:**

```bash
claude mcp add browser \
  -e OUTPUT_DIR="$(pwd)/screenshots" \
  -e CHROMIUM_PATH=/usr/bin/chromium \
  -- node "$(pwd)/index.js"
claude mcp list         # verify (shows "✔ Connected")
```

**opencode:**

```bash
opencode mcp add browser \
  --env OUTPUT_DIR="$(pwd)/screenshots" \
  --env CHROMIUM_PATH=/usr/bin/chromium \
  -- node "$(pwd)/index.js"
opencode mcp list       # verify
```

> Registration flags vary slightly between CLI versions — check `codex mcp add --help`, `claude mcp add --help`, or `opencode mcp add --help`.

---

## Configuration

Configuration is entirely environment-driven. **The server does not auto-load `.env` files** — set variables in your shell or pass them through your MCP client's registration (`--env` / `-e`). Copy [`.env.example`](.env.example) as a reference for every variable, its type, default, and valid range.

Priority (highest wins): **tool argument → environment variable → default → hard limit**. All values are read once at server startup. Boolean flags accept `1`, `true`, or `yes` (case-insensitive).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CHROMIUM_PATH` | No | auto-detect | Path to the Chromium binary. When empty, the server checks `/usr/bin/chromium-browser`, `/usr/bin/chromium`, `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`. |
| `OUTPUT_DIR` | No | `./screenshots` | Directory where screenshots are written. Must be writable; filenames are validated so output cannot escape this directory. |
| `ALLOW_PRIVATE_NETWORKS` | No | `false` | Allow navigation to private ranges (`10.x`, `192.168.x`, `172.x`, `*.local`, `*.internal`). `localhost`/`127.0.0.1`/`::1` are always allowed. |
| `ENABLE_EVAL_JS` | No | `false` | Enable the `browser_evaluate` tool. **Disabled by default**; while off, the tool is refused with `EVAL_DISABLED` before any browser resource is used. Enabling it allows arbitrary page JavaScript (see [Security](#security)). |
| `NAVIGATION_TIMEOUT_MS` | No | `30000` | Default timeout for `browser_navigate`. Range: `100`–`MAX_TIMEOUT_MS`. |
| `TOOL_TIMEOUT_MS` | No | `10000` | Default timeout for `browser_click`, `browser_type`, `browser_get_text`, `browser_hover`, `browser_press`, `browser_evaluate`. Range: `100`–`MAX_TIMEOUT_MS`. |
| `MAX_TIMEOUT_MS` | No | `120000` | Hard upper bound applied to every timeout; tool arguments cannot exceed it. |
| `IDLE_SHUTDOWN_MS` | No | `300000` | Idle time before the browser is shut down; `0` disables idle shutdown. The MCP server stays alive either way. |
| `MAX_TEXT_LENGTH` | No | `1000000` | Maximum characters returned by `browser_get_text` before truncation. |
| `MAX_CONSOLE_MESSAGES` | No | `500` | Size of the in-memory console ring buffer. |
| `MAX_CONSOLE_LINES` | No | `500` | Maximum lines returned by `browser_get_console`. |
| `MAX_SNAPSHOT_ITEMS` | No | `100` | Default item count for `browser_snapshot` (hard cap `200`). |
| `MAX_SCREENSHOT_PIXELS` | No | `16000000` | Maximum screenshot area before auto-downscaling (16M ≈ 4000×4000). |
| `MAX_IMAGE_BYTES` | No | `10000000` | Maximum image payload bytes accepted in a response. Also enforced on screenshots by post-capture measurement. |
| `MAX_EVAL_LENGTH` | No | `100000` | Maximum characters for a `browser_evaluate` expression and for its JSON-stringified result before truncation. |
| `QUEUE_LIMIT` | No | `8` | Maximum queued state-changing operations before `BUSY_QUEUE_FULL`. Range: `1`–`64`. |

**Reserved (accepted but not yet implemented):** `MAX_REDIRECTS` (Chromium follows redirects natively) and `LOG_LEVEL` (all logging currently goes to stderr at a single verbosity). They are documented so configuration written against `.env.example` stays valid.

---

## API Reference

Base transport: **MCP stdio**. Every tool returns MCP text content containing JSON. Errors are returned as `isError: true` with a `[ERROR_CODE]` prefix in the message.

### Quick Reference

| Tool | Mode | Locked | Purpose |
|------|------|--------|---------|
| `browser_navigate` | state-changing | ✅ | Navigate to a URL (validated) |
| `browser_get_text` | reading | — | Read body text or a specific element |
| `browser_screenshot` | reading / state-changing | ✅ when `full_page` | Capture the viewport or the full page |
| `browser_get_console` | reading | — | Read buffered console messages |
| `browser_snapshot` | reading | — | Accessibility snapshot of interactive elements |
| `browser_click` | state-changing | ✅ | Real mouse click at a computed point |
| `browser_type` | state-changing | ✅ | Type into input/textarea/contenteditable |
| `browser_wait_for` | reading | — | Wait for an element and/or text |
| `browser_scroll` | reading | — | Scroll by direction, element, or coordinates |
| `browser_resize` | state-changing | ✅ | Resize the viewport (preset, explicit size, or reset) |
| `browser_evaluate` | state-changing | ✅ | Evaluate page JavaScript (gated by `ENABLE_EVAL_JS`) |
| `browser_hover` | state-changing | ✅ | Move the mouse over an element |
| `browser_press` | state-changing | ✅ | Press a key, optionally focusing an element |

> Reading tools still wait for any in-flight navigation before touching the page, and every tool call resets the idle timer.

### browser_navigate

- **Params**: `url` (string, required), `timeout_ms` (≤ 120000, default 30000)
- **Returns**: `{ url, title, status }` — `status` is the HTTP status of the main document, and `url` is the real post-redirect URL (tracked via `Page.frameNavigated`)
- **Behavior**: hash-only (same-document) changes are detected before navigating and awaited on `Page.navigatedWithinDocument`, never on `Page.loadEventFired`; the handler then waits ~200 ms + double-rAF so a following screenshot is not blank
- **Errors**: `INVALID_URL` (rejected scheme), private-network block, navigation timeout

```json
{ "name": "browser_navigate", "arguments": { "url": "https://example.com" } }
```

### browser_get_text

- **Params**: `selector` (string, optional — omit for the whole body), `timeout_ms` (default 10000)
- **Returns**: `{ text, truncated, length }`
- **Behavior**: with a selector, form elements (`input`/`textarea`/`select`) return their `value` property (typed/selected content — `innerText` would be empty); all other elements return `innerText`. Without a selector, returns `document.body.innerText`
- **Errors**: `ELEMENT_NOT_FOUND`, timeout

```json
{ "name": "browser_get_text", "arguments": { "selector": "#username" } }
```

### browser_screenshot

- **Params**: `filename` (optional, auto-generated), `format` (`jpeg`|`png`, default `jpeg`), `quality` (1–100, default 80), `full_page` (boolean, default false), `delay_ms` (0–5000, default 0)
- **Returns**: `{ path, size, truncated, width, height, scale, measured }` plus inline base64 image content — `width`/`height` are the real measured dimensions, `truncated` means it was downscaled (never cropped), and `measured` reports whether the dimensions were decoded
- **Errors**: `UNSAFE_PATH` (absolute paths or `..` rejected), `SCREENSHOT_TOO_LARGE`
- **Limit handling**: a best-effort pre-capture estimate using `deviceScaleFactor`/page scale sets an initial scale; after each capture the real PNG/JPEG header is decoded from the buffer (`decodeImageSize`) and the byte size checked. If either exceeds `MAX_SCREENSHOT_PIXELS`/`MAX_IMAGE_BYTES`, the capture is downscaled via `clip.scale` and retried once (this catches `mobile: true` page-scale inflation the estimate misses)
- **Full-page details**: scrolls through the page first so lazy/IntersectionObserver sections paint, re-reads layout metrics, temporarily overrides the viewport to the full page height, and restores the previous viewport in a `finally` block (a prior `browser_resize` is preserved, not cleared) — the full page is captured at lower resolution, never cropped
- **Viewport details**: normally no `clip` is passed to `Page.captureScreenshot`; a clip with `captureBeyondViewport: false` produces a blank frame on scrolled pages. A clip is only added when downscaling is required, together with `captureBeyondViewport: true`
- **Locked** only when `full_page: true`; viewport shots are read-only
- **Output**: written to `OUTPUT_DIR` and returned inline

```json
{ "name": "browser_screenshot", "arguments": { "full_page": true, "format": "png", "delay_ms": 500 } }
```

### browser_get_console

- **Params**: `level` (`all`|`error`|`warning`|`log`|`info`|`debug`, default `all`), `clear_after` (boolean, default false)
- **Returns**: `{ messages, count, cleared, truncated, droppedCount }`
- **Behavior**: ring buffer populated by `Runtime.consoleAPICalled` (with `Runtime.exceptionThrown` recorded as errors); the buffer clears on each main-frame navigation

### browser_snapshot

- **Params**: `include_text` (boolean, default true), `max_items` (≤ 200, default 100)
- **Returns**: `{ elements, count, truncated }` — each element carries `role`, `name`, `description`, a best-effort CSS `selector`, and `state` flags (`checked`, `expanded`, `disabled`, `selected`, `readonly`, `required`)
- **Behavior**: walks the accessibility tree for interactive roles, resolves selectors via `DOM.describeNode` with a `Runtime.evaluate` fallback, and returns selectors ready to pass to the interaction tools

### browser_click

- **Params**: `selector` (string, required), `force` (boolean, default false), `timeout_ms` (default 10000)
- **Returns**: `{ clicked: true, selector, x, y, forced? }`
- **Behavior**: waits for the element → checks visibility → scrolls it into view (`behavior: 'instant'`, then ~100 ms + double-rAF settle) → performs a multi-point hit test (center + four quadrants; a free quadrant is used when the center is covered, and the point is re-read once for below-viewport/sticky-header layouts) → dispatches real mouse events via `Input.dispatchMouseEvent`. With `force: true`, a fully covered element falls back to JavaScript `.click()` and returns `forced: true` (Playwright-style). Includes a post-click render settle and retries on stale element handles
- **Errors**: `ELEMENT_NOT_FOUND`, `ELEMENT_HIDDEN`, `ELEMENT_NOT_CLICKABLE` (covered, no `force`), invalid selector (SyntaxError)
- **Locked**

### browser_type

- **Params**: `selector` (required), `text` (required), `clear_first` (boolean, default true), `timeout_ms` (default 10000)
- **Returns**: `{ typed: true, selector, length, finalLength }`
- **Behavior**: works on `input`, `textarea`, and `contenteditable`; types character-by-character with per-character `input` events and a final `change` event. Uses the native value setter so React-style value trackers observe changes, and `execCommand('insertText')` for contenteditable. Arabic/RTL, Chinese, emoji, and special characters are verified
- **Errors**: `ELEMENT_NOT_FOUND`, `ELEMENT_NOT_TYPEABLE`
- **Security**: the typed `text` is **never** written to logs (only its length)
- **Locked**

### browser_wait_for

- **Params**: `selector` (optional), `text` (optional), `timeout_ms` (default 15000) — at least one of `selector`/`text` is required
- **Returns**: `{ found: true, selector, text, elapsed_ms }`
- **Behavior**: polls every 100 ms; text matching normalizes whitespace but **not** diacritics (literal match)
- **Errors**: `INVALID_ARGS` (neither given), `TIMEOUT`

### browser_scroll

- **Params** (exactly one mode required): `direction` (`up`|`down`|`left`|`right`|`top`|`bottom`), `selector`, `x`/`y`, or `pixels`
- **Returns**: `{ scrollX, scrollY, mode, ... }`
- **Behavior**: Mode A scrolls by direction (~80% of the viewport dimension, or an exact `pixels` count); Mode B scrolls a selector into view and verifies it is in the viewport; Mode C scrolls to absolute `x`/`y`. All modes use `behavior: 'instant'` and wait ~100 ms + double-rAF before returning, so a screenshot in the next tool call is reliable
- **Errors**: `INVALID_ARGS` (no mode, conflicting modes, or `x` without `y`), `ELEMENT_NOT_FOUND` (selector mode)
- **Locked**: no (viewport state, not DOM state)

### browser_resize

- **Params** (exactly one mode required): `preset` (`mobile`|`tablet`|`desktop`), `width`+`height` (100–10000), or `reset: true`; optional `device_scale_factor` (1–4) and `mobile` overrides; optional `timeout_ms`
- **Returns**: `{ resized: true, width, height, deviceScaleFactor, mobile, preset, reset }`
- **Presets**: mobile `390×844 @3 mobile`, tablet `768×1024 @2 mobile`, desktop `1280×800 @1`
- **Behavior**: validation runs on the raw arguments (not Zod-normalized), so `reset` and an empty call are distinguishable. The override is stored on the browser object, survives navigation and idle shutdown, is re-applied after a crash restart, and is **restored** (not cleared) after a `full_page` screenshot. Settles with a double-rAF after applying
- **Errors**: `INVALID_ARGS` (no mode, conflicting modes, width without height, reset combined with other options), `VIEWPORT_APPLY_FAILED`
- **Locked**

```json
{ "name": "browser_resize", "arguments": { "preset": "mobile" } }
{ "name": "browser_resize", "arguments": { "width": 500, "height": 700, "device_scale_factor": 2 } }
{ "name": "browser_resize", "arguments": { "reset": true } }
```

### browser_evaluate

- **Params**: `expression` (string, required, ≤ `MAX_EVAL_LENGTH`), `await_promise` (default `true`), `user_gesture` (default `false`), `timeout_ms` (default 10000)
- **Returns**: `{ result, type, truncated }`
- **Behavior**: **disabled by default** — refused with `EVAL_DISABLED` before the browser starts unless `ENABLE_EVAL_JS=1`. Primitives are returned directly; objects, arrays, functions, and DOM nodes are serialized in-page by a fixed helper (cycles marked, depth 4, 100 properties, `Date`/`Error`/`Element`/`Map`/`Set`/`BigInt`/`Symbol` readable). The result is JSON-stringified and truncated to `MAX_EVAL_LENGTH`. The remote object handle is always released
- **Errors**: `EVAL_DISABLED` (gate off), `EVAL_ERROR` (in-page exception, with description), `TIMEOUT`
- **Locked**

```json
{ "name": "browser_evaluate", "arguments": { "expression": "document.querySelectorAll('a').length" } }
{ "name": "browser_evaluate", "arguments": { "expression": "fetch('/api').then(r => r.status)", "await_promise": true } }
```

### browser_hover

- **Params**: `selector` (required), `timeout_ms` (default 10000)
- **Returns**: `{ hovered: true, selector, x, y, matchesHover }`
- **Behavior**: waits for the element, checks visibility, scrolls it into view (`instant` + settle), resolves an unobstructed point (center + quadrants), and moves the real mouse there. If `:hover` does not engage, a nudge (away then back) is attempted. `matchesHover` is diagnostic — some elements have no `:hover` style
- **Errors**: `ELEMENT_NOT_FOUND`, `ELEMENT_HIDDEN`
- **Locked**

### browser_press

- **Params**: `key` (required), `modifiers` (`Alt`|`Control`|`Meta`|`Shift`[], default `[]`), `selector` (optional — focused first), `repeat` (1–100, default 1), `timeout_ms` (default 10000)
- **Returns**: `{ pressed: true, key, modifiers, count, selector, focused }`
- **Behavior**: keys are resolved by `src/keymap.js` — named keys (`Enter`, `Tab`, `Escape`, arrows, `F1`–`F12`, …) or a single character. Enter/Tab/Space carry text so default actions fire (form submit, focus traversal). Sends `keyDown`/`rawKeyDown` then `keyUp`, and settles before returning
- **Errors**: `KEY_NOT_SUPPORTED` (unknown key), `INVALID_ARGS`, `ELEMENT_NOT_FOUND`, `ELEMENT_HIDDEN`
- **Locked**
- **Security**: a single-character key is never logged (recorded as `<char>`)

```json
{ "name": "browser_press", "arguments": { "key": "Enter", "selector": "#form-input" } }
{ "name": "browser_press", "arguments": { "key": "a", "modifiers": ["Control"] } }
```

### Error codes

| Code | Meaning |
|------|---------|
| `INVALID_URL` | URL scheme rejected or unparseable |
| `UNSAFE_PATH` | Screenshot filename is absolute or escapes `OUTPUT_DIR` |
| `INVALID_ARGS` | Tool arguments are missing, conflicting, or incomplete |
| `ELEMENT_NOT_FOUND` | Selector never resolved within the timeout |
| `ELEMENT_HIDDEN` | Element exists but is hidden or zero-sized |
| `ELEMENT_NOT_CLICKABLE` | Element is covered by an overlay and `force` was not set |
| `ELEMENT_NOT_TYPEABLE` | Element is not an input, textarea, or contenteditable |
| `KEY_NOT_SUPPORTED` | `browser_press` key is not a known named key or single character |
| `EVAL_DISABLED` | `browser_evaluate` called while `ENABLE_EVAL_JS` is off |
| `EVAL_ERROR` | JavaScript threw inside the page (message includes the exception) |
| `VIEWPORT_APPLY_FAILED` | CDP failed to apply the `browser_resize` override |
| `SCREENSHOT_TOO_LARGE` | Capture still exceeded pixel/byte limits after the one re-scale attempt |
| `TIMEOUT` | Operation exceeded its timeout |
| `BUSY_QUEUE_FULL` | Operation queue is at capacity (`QUEUE_LIMIT`); retry later |
| `BROWSER_NOT_READY` | A CDP command was attempted while the browser was not ready |
| `CDP_ERROR` | CDP/WebSocket failure, including exhausted reconnect attempts |
| `CHROMIUM_RESTART_FAILED` | Chromium crashed repeatedly (2 restarts); includes last stderr |
| `NAVIGATION_FAILED` | Navigation did not reach a loaded state |

---

## Security

- **URL policy**: only `http:`, `https:`, and `about:` are permitted. `file:`, `javascript:`, `data:`, and `vbscript:` are rejected. Private IP ranges are blocked by default (`ALLOW_PRIVATE_NETWORKS=1` to allow), while `localhost`/`127.0.0.1`/`::1` are always permitted.
- **Safe output paths**: screenshot filenames cannot be absolute or contain `..`, and resolved paths must stay inside `OUTPUT_DIR`.
- **Gated JavaScript execution**: `browser_evaluate` is **disabled by default** and refused with `EVAL_DISABLED` before any browser resource is used. When enabled (`ENABLE_EVAL_JS=1`) the page code can read `document.cookie`/`localStorage` and issue `fetch()` requests to internal networks (**SSRF**) that bypass the navigation-only `validateURL` check — only enable it on trusted pages. No other tool executes user-supplied JavaScript.
- **CSS selectors only**: interaction tools accept CSS selectors, never JavaScript.
- **Injection-proof arguments**: selectors and typed text travel as CDP `arguments` values and are never concatenated into JavaScript source — `'); maliciousCode(); ('` is treated as literal data. The `browser_evaluate` expression is the deliberate exception, and it is gated.
- **Sensitive data**: `browser_type` never logs the typed text; `browser_press` logs a single-character key as `<char>`.
- **Resource limits**: text, console, screenshot, snapshot, and eval outputs are capped; timeouts are bounded by `MAX_TIMEOUT_MS`; screenshot pixel/byte limits are verified against the real captured image.
- **Never commit secrets**: no credentials are required, but keep `.env` files and local configuration out of version control.

---

## Testing and Quality

```bash
# Run the full suite (258 tests across 22 files)
npm test

# Run a single test file
node --test tests/interaction.test.js

# Low-RAM devices: run one file at a time with bounded concurrency
node --test --test-concurrency=1 tests/resize.test.js
```

`npm test` runs `node --test --test-concurrency=3 tests/*.test.js`. Tests use the built-in `node:test` runner with `node:assert/strict` — no external test framework. Shared integration helpers live in `tests/harness.js` (fixture server, MCP child process, buffered JSON-RPC).

Coverage spans:

- **Unit**: URL/path validation, truncation and limits, viewport argument resolution, key resolution/modifier bitmasks, image-size decoding, eval gate, CDP request/response correlation, operation-lock behavior, in-page helper security
- **Browser lifecycle**: launch, crash + restart, WebSocket reconnect, lazy start, idle shutdown, cleanup with no leaked processes
- **Tool integration**: reading tools, interaction tools (click/type/wait_for/scroll), resize (presets, persistence, full-page survival), evaluate (gate, DOM, cycles, promises, exceptions, truncation), hover/press, screenshot limit enforcement, parallel instances and lock serialization
- **Security**: injection resistance and absence of sensitive logging

Integration tests spawn real Chromium, so they require Chromium to be installed (see [Install Chromium](#install-chromium)). `--test-concurrency=3` keeps concurrent Chromium instances bounded on low-RAM devices (5.5 GB in testing); raise it on beefier hardware. On very small devices, `memory.test.js` (50 start/stop cycles) is the heaviest file — run it alone and last.

A stress test for start/stop cycles (checking for leaked Chromium processes and RSS growth) is also included:

```bash
./stress-test.sh          # default 50 cycles
./stress-test.sh 20       # custom cycle count
```

There is no lint, typecheck, or build step.

---

## Memory Usage

Measured on aarch64 / Ubuntu 26.04 (server process RSS, `VmRSS`):

| Stage | RSS |
|-------|-----|
| Server started (before browser) | ~70 MB |
| After browser start + navigation | ~74 MB |
| After screenshot / interactions | ~74 MB (stable, no growth) |
| Chromium child process (separate) | ~100–150 MB |

- 50 start/stop cycles (`./stress-test.sh`): no RSS growth and no leaked Chromium processes
- The server returns to baseline after the browser is shut down

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Chromium not found` | Binary is not at a known path | Run `sudo ./install-chromium.sh` (Debian/Ubuntu) or install Chromium and set `CHROMIUM_PATH=/path/to/chromium` |
| `Private network blocked` | URL resolves to a private range | Set `ALLOW_PRIVATE_NETWORKS=1` if intentional |
| `CHROMIUM_RESTART_FAILED` | Chromium crashed repeatedly (2 restarts) | Read the last stderr lines included in the error, then restart the MCP server |
| `BUSY_QUEUE_FULL` | Operation queue at capacity (8) | Retry once other operations finish, or raise `QUEUE_LIMIT` |
| Screenshots missing | `OUTPUT_DIR` missing/unwritable, or bad filename | Check `OUTPUT_DIR`; `UNSAFE_PATH` errors indicate absolute paths or `..` |
| No console output from the server | All logs go to stderr | Capture it (`2> server.log`) or enable stderr in your MCP client |
| Typing doesn't trigger app handlers | Framework ignores native events | The server dispatches `input`/`change` via the native value setter; frameworks that bypass native events may need their own listeners |
| Blank page after hash navigation | Same-document navigation has no load event | The handler settles ~200 ms + double-rAF; give it a beat before the next screenshot |
| Blank middle sections in a full-page shot | Lazy/IntersectionObserver content not painted | Use `full_page: true` (warm-up scroll runs automatically); add `delay_ms` for heavy animation |
| Blank viewport screenshot on a scrolled page | An explicit `clip` on a scrolled page | Handled internally — viewport captures pass no `clip`; update if you patched that code |
| Verify Chromium works | — | `chromium --headless --no-sandbox --dump-dom about:blank` |

---

## Tested Versions

This server has been tested and verified on:

- **Node.js**: v26.2.0
- **npm**: 11.13.0
- **Chromium**: 150.0.7871.100 (built on Debian GNU/Linux 12)
- **Ubuntu**: 26.04 LTS (codename resolute, inside proot-distro)
- **Architecture**: aarch64 (ARM64)
- **MCP clients**: codex-cli 0.142.5, Claude Code 2.1.209, opencode 1.18.11

Known version notes:

- Node.js older than 20 may not support the syntax used here
- Chromium versions differ across distributions; any recent build with CDP support works
- On this ARM64/Termux environment, `proot-distro` prints a root/PRoot warning; the server itself is unaffected

---

## Contributing

Contributions are welcome. Before opening a pull request:

1. Run the test suite (`npm test`) and ensure it passes; run `node --test tests/<file>.test.js` for focused changes.
2. Keep new tools consistent with the existing pattern: validate input → `ensureBrowserReady()` → issue CDP/Runtime work → `resetIdleTimer()`, and decide whether the operation needs `runLocked()`.
3. Pass user-supplied selectors/text as CDP `arguments` values — never build JavaScript source from them.
4. Preserve state-changing/full-page operations behind the operation lock and reset any emulation overrides in a `finally` block.
5. Update `.env.example` whenever you add or change an environment variable.
6. Never commit `.env` files, credentials, or generated screenshots.
7. Follow the existing code style and module boundaries (`src/` modules own their layer; `index.js` stays orchestration + registration).

---

## License

This project is licensed under the [MIT License](LICENSE).
