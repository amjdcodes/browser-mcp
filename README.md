<!-- Badges: verified against package.json, node --version, and the Chromium binary. -->
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-brightgreen?logo=nodedotjs&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio%20JSON--RPC-blue)
![Chromium](https://img.shields.io/badge/Chromium-150.0.7871.100-4285F4?logo=googlechrome&logoColor=white)
![Platform](https://img.shields.io/badge/platform-aarch64%20%C2%B7%20x86__64-lightgrey)
![Tests](https://img.shields.io/badge/tests-180%20(node%3Atest)-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

# browser-mcp

> An MCP server that lets AI assistants drive headless Chromium over raw CDP — navigate, read, screenshot, click, type, and scroll — with no Puppeteer or Playwright dependency.

[What It Does](#what-it-does) · [Key Features](#key-features) · [Architecture](#architecture) · [Project Structure](#project-structure) · [Quick Start](#quick-start) · [Configuration](#configuration) · [API Reference](#api-reference) · [Security](#security) · [Testing and Quality](#testing-and-quality) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing)

---

## What It Does

`browser-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives an AI client — Codex CLI, Claude Code, opencode, or any MCP-capable host — a real browser it can read from and interact with. It implements the protocol over stdio and controls headless Chromium directly through the Chrome DevTools Protocol (CDP) WebSocket, so there is no Puppeteer/Playwright layer to install, pin, or fight with.

The server exposes nine tools: `browser_navigate`, `browser_get_text`, `browser_screenshot`, `browser_get_console`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_wait_for`, and `browser_scroll`. Together they cover the common agent loop — open a page, snapshot the interactive elements, click and type, wait for state to change, and capture the result as an image or text.

It is built for resource-constrained and ARM64 environments. Chromium launches lazily on the first tool call, shuts itself down after an idle period, and cleans up its process group and temporary profile so repeated start/stop cycles leak neither memory nor browser processes. State-changing operations are serialized behind a single lock, and reading operations wait for any in-flight navigation, so concurrent tool calls cannot race the page.

Use it when you want browser automation available to an AI assistant without bundling a heavyweight automation framework, or when you need it to run on aarch64 (for example inside a proot-distro container on Android/Termux). Its distinguishing trait is the deliberately thin stack: it speaks CDP itself, and it hardens the sharp edges (blank screenshots, stale frames, hash-only navigation, modal dialogs, overlay-covered clicks) that a raw CDP integration usually runs into.

---

## Key Features

- **Nine browser tools over MCP stdio** — navigation, text extraction, screenshots, console capture, accessibility snapshots, clicks, typing, waiting, and scrolling.
- **Raw CDP, zero browser-framework dependencies** — only `@modelcontextprotocol/sdk`, `ws`, and `zod`; no Puppeteer or Playwright.
- **ARM64-native** — developed and verified on aarch64 (see [Tested Versions](#tested-versions)).
- **Lazy browser start** — Chromium launches on the first tool call, not at server startup.
- **Idle shutdown** — the browser stops after inactivity (default 5 min) while the MCP server stays alive and restarts it on demand. Idle never interrupts an in-flight tool call, and any new request extends the window.
- **Crash recovery** — automatic WebSocket reconnect to the same process (exponential backoff) and full Chromium restart on crash (up to 2 attempts).
- **Operation lock** — state-changing operations are serialized; the FIFO queue is capped at `QUEUE_LIMIT` (8) and rejects with `BUSY_QUEUE_FULL`, with a 5-minute watchdog backstop.
- **Navigation race guard** — reading tools wait for any in-flight navigation before touching the page.
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
  │  MCP server · 9 tool handlers · result + image content        │
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
| Protocol / Interface | Speak MCP over stdio and expose the nine tools | `index.js` (`McpServer`, `StdioServerTransport`, tool registrations) |
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
├── index.js                  # MCP server entry point: 9 tool registrations, lock, idle timer
├── src/
│   ├── browser.js            # Chromium lifecycle: spawn, CDP connect, reconnect, restart, cleanup
│   ├── cdp.js                # Raw CDP WebSocket client (request/response correlation, events)
│   ├── helpers.js            # In-page helpers (IN_PAGE) + node-side runners (click/type/wait/scroll)
│   ├── lock.js               # FIFO operation lock with queue limit and watchdog release
│   ├── console-buffer.js     # In-memory ring buffer for console messages
│   └── utils.js              # URL/path validation, truncation, timeout caps, CONFIG
├── tests/                    # 180 tests across 16 files (node:test + node:assert/strict)
│   ├── utils.test.js         # Validation, truncation, limits
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
| `NAVIGATION_TIMEOUT_MS` | No | `30000` | Default timeout for `browser_navigate`. Range: `100`–`MAX_TIMEOUT_MS`. |
| `TOOL_TIMEOUT_MS` | No | `10000` | Default timeout for `browser_click`, `browser_type`, `browser_get_text`. Range: `100`–`MAX_TIMEOUT_MS`. |
| `MAX_TIMEOUT_MS` | No | `120000` | Hard upper bound applied to every timeout; tool arguments cannot exceed it. |
| `IDLE_SHUTDOWN_MS` | No | `300000` | Idle time before the browser is shut down; `0` disables idle shutdown. The MCP server stays alive either way. |
| `MAX_TEXT_LENGTH` | No | `1000000` | Maximum characters returned by `browser_get_text` before truncation. |
| `MAX_CONSOLE_MESSAGES` | No | `500` | Size of the in-memory console ring buffer. |
| `MAX_CONSOLE_LINES` | No | `500` | Maximum lines returned by `browser_get_console`. |
| `MAX_SNAPSHOT_ITEMS` | No | `100` | Default item count for `browser_snapshot` (hard cap `200`). |
| `MAX_SCREENSHOT_PIXELS` | No | `16000000` | Maximum screenshot area before auto-downscaling (16M ≈ 4000×4000). |
| `MAX_IMAGE_BYTES` | No | `10000000` | Maximum image payload bytes accepted in a response. |
| `QUEUE_LIMIT` | No | `8` | Maximum queued state-changing operations before `BUSY_QUEUE_FULL`. Range: `1`–`64`. |

**Reserved (accepted but not yet implemented):** `ENABLE_EVAL_JS` (there is no tool that executes arbitrary JavaScript), `MAX_REDIRECTS` (Chromium follows redirects natively), and `LOG_LEVEL` (all logging currently goes to stderr at a single verbosity). They are documented so configuration written against `.env.example` stays valid.

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
- **Returns**: `{ path, size, truncated }` plus inline base64 image content
- **Errors**: `UNSAFE_PATH` (absolute paths or `..` rejected)
- **Full-page details**: scrolls through the page first so lazy/IntersectionObserver sections paint, re-reads layout metrics, temporarily overrides the viewport to the full page height (always reset, even on failure), and downscales pages over 16M pixels via `clip.scale` — the full page is captured at lower resolution, never cropped
- **Viewport details**: no `clip` is passed to `Page.captureScreenshot`; a clip with `captureBeyondViewport: false` produces a blank frame on scrolled pages
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
- **No arbitrary code execution**: there is no eval-JS tool. (`ENABLE_EVAL_JS` is reserved and unimplemented.)
- **CSS selectors only**: interaction tools accept CSS selectors, never JavaScript.
- **Injection-proof arguments**: selectors and typed text travel as CDP `arguments` values and are never concatenated into JavaScript source — `'); maliciousCode(); ('` is treated as literal data.
- **Sensitive data**: `browser_type` never logs the typed text.
- **Resource limits**: text, console, screenshot, and snapshot outputs are capped, and timeouts are bounded by `MAX_TIMEOUT_MS`.
- **Never commit secrets**: no credentials are required, but keep `.env` files and local configuration out of version control.

---

## Testing and Quality

```bash
# Run the full suite (180 tests across 16 files)
npm test

# Run a single test file
node --test tests/interaction.test.js
```

`npm test` runs `node --test --test-concurrency=3 tests/*.test.js`. Tests use the built-in `node:test` runner with `node:assert/strict` — no external test framework.

Coverage spans:

- **Unit**: URL/path validation, truncation and limits, CDP request/response correlation, operation-lock behavior, in-page helper security
- **Browser lifecycle**: launch, crash + restart, WebSocket reconnect, lazy start, idle shutdown, cleanup with no leaked processes
- **Tool integration**: reading tools, interaction tools (click/type/wait_for/scroll), parallel instances and lock serialization
- **Security**: injection resistance and absence of sensitive logging

Integration tests spawn real Chromium, so they require Chromium to be installed (see [Install Chromium](#install-chromium)). `--test-concurrency=3` keeps concurrent Chromium instances bounded on low-RAM devices (5.5 GB in testing); raise it on beefier hardware.

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
