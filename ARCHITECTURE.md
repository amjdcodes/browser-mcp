# Architecture

## Project Overview

**browser-mcp** is an MCP (Model Context Protocol) server that provides headless Chromium browser automation via raw CDP (Chrome DevTools Protocol). It exposes 13 tools for AI assistants to control a browser instance.

- **Runtime**: Node.js (ESM modules, `"type": "module"`)
- **Protocol**: MCP over stdio transport
- **Browser Control**: Raw CDP WebSocket (no Puppeteer/Playwright)
- **Dependencies**: `@modelcontextprotocol/sdk`, `ws`, `zod`

---

## Folder Structure

```
browser-mcp/
├── index.js                    # MCP server entry point, tool definitions
├── src/                        # Core implementation
│   ├── browser.js              # Chromium lifecycle + persistent viewport state
│   ├── cdp.js                  # Raw CDP WebSocket client
│   ├── console-buffer.js       # In-memory console message buffer
│   ├── helpers.js              # In-page interaction helpers (callFunctionOn)
│   ├── keymap.js               # Key resolution for browser_press
│   ├── lock.js                 # Operation lock (mutex + bounded queue)
│   ├── utils.js                # Validation, truncation, error formatting, image size decode
│   └── viewport.js             # Viewport presets + raw resize validation
├── tests/                      # Unit and integration tests (node:test)
│   ├── browser.test.js         # Browser class tests
│   ├── cdp.test.js             # CDP client tests
│   ├── utils.test.js           # Utility function tests
│   ├── helpers.test.js         # In-page helper security/unit tests
│   ├── lock.test.js            # Operation lock behavior tests
│   ├── integration.test.js     # End-to-end browser tests
│   ├── mcp-handshake.test.js   # MCP protocol handshake tests
│   ├── reading-tools.test.js   # Reading tool functionality tests
│   └── interaction.test.js     # Click/type/wait_for integration tests
├── fixtures/                   # Test fixtures
│   ├── test-page.html          # Shared HTML test fixture (interactive)
│   └── page2.html              # Navigation target for click tests
├── screenshots/                # Screenshot output directory (runtime)
└── node_modules/               # Dependencies
```

---

## Key Files

### `index.js` (Entry Point)

**Role**: MCP server initialization and tool registration

**Responsibilities**:
- Creates MCP server instance with stdio transport
- Registers 13 tools: `browser_navigate`, `browser_get_text`, `browser_screenshot`, `browser_get_console`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_wait_for`, `browser_scroll`, `browser_resize`, `browser_evaluate`, `browser_hover`, `browser_press`
- Manages browser lifecycle (lazy initialization on first tool call)
- Implements idle timeout shutdown (default 5 minutes)
- Serializes state-changing operations (click/type/navigate/full-page screenshot) via `src/lock.js`
- Handles navigation state tracking to prevent race conditions
- Processes shutdown signals (SIGINT, SIGTERM, stdin close)

**Key Functions**:
- `ensureBrowserReady()` - Lazy browser initialization; waits during reconnect/restart recovery; surfaces `CHROMIUM_RESTART_FAILED` with last stderr on crash-loop
- `resetIdleTimer()` - Resets idle shutdown timer on each tool call (reschedules while operations are in flight; `IDLE_SHUTDOWN_MS=0` disables)
- `withActivityTracking(handler)` - Wraps every tool handler; tracks in-flight operations so idle shutdown never interrupts them
- `runLocked(fn)` - Runs a state-changing operation behind the operation lock
- `shutdown()` - Graceful cleanup on exit

**State Management**:
- `navigationPromise` - Tracks in-flight navigation to prevent concurrent operations
- `idleTimer` - Auto-shutdown after inactivity

---

### `src/browser.js` (Browser Lifecycle)

**Role**: Chromium process management and CDP connection

**Responsibilities**:
- Spawns Chromium process with headless flags
- Discovers CDP port via `DevToolsActivePort` file
- Establishes WebSocket connection to page target
- Enables CDP domains: Page, Runtime, Network, DOM, Accessibility
- Sets up console message listeners
- Handles crash recovery (auto-restart up to 2 times)
- Manages temporary profile directory cleanup

**State Machine**:
```
STOPPED → STARTING → READY → RECONNECTING → READY (WS drop, same process)
                     ↓                ↓ (limit exceeded)
                  RECONNECTING → FAILED
READY → RESTARTING → (cleanup) → STARTING → READY (crash, new process)
                     ↓ (limit exceeded)
                  FAILED
STOPPING → STOPPED
```

**Key Methods**:
- `start()` - Spawns Chromium (own process group, `detached: true`), waits for DevTools port, connects to page
- `send(method, params, timeout)` - Sends CDP command; throws `[CHROMIUM_RESTART_FAILED]` with last stderr when the browser is failed
- `cleanup()` - Kills the whole Chromium process group, closes WebSocket, removes profile dir (with retry)
- `_handleCrash()` - Auto-restart on unexpected exit (up to `maxRestartAttempts`)
- `_reconnect()` - Reconnect to the SAME process after a WebSocket drop (exponential backoff, up to `maxReconnectAttempts`)
- `_handleConnectionLost()` - CDP 'close' → reconnect while the process is alive

**Critical Constants**:
- `KNOWN_PATHS` - Default Chromium binary locations
- `DEFAULT_FLAGS` - Headless Chromium launch flags
- `STATES` - Browser state enum

---

### `src/cdp.js` (CDP Client)

**Role**: Raw Chrome DevTools Protocol WebSocket client

**Responsibilities**:
- Manages WebSocket connection to Chromium
- Correlates requests/responses by ID
- Emits CDP events (e.g., `Page.loadEventFired`, `Runtime.consoleAPICalled`)
- Handles timeouts and pending request cleanup
- Provides request/response correlation

**Key Methods**:
- `connect(wsUrl)` - Establishes WebSocket connection
- `send(method, params, timeout)` - Sends CDP command, returns Promise
- `close()` - Gracefully closes WebSocket
- `_handleMessage(data)` - Routes responses to pending requests, emits events

**Internal State**:
- `pending` - Map of pending requests (id → {resolve, reject, timer, method})
- `nextId` - Auto-incrementing request ID counter
- `connected` - Connection state flag

---

### `src/console-buffer.js` (Console Buffer)

**Role**: In-memory ring buffer for browser console messages

**Responsibilities**:
- Stores console messages (log, error, warning, info, debug)
- Implements ring buffer with max capacity (default 500 messages)
- Filters messages by level
- Truncates output to prevent oversized responses
- Clears buffer on main-frame navigation

**Key Methods**:
- `add(message)` - Adds message, evicts oldest if at capacity
- `clear()` - Empties buffer (called on navigation)
- `getMessages(level)` - Returns filtered messages
- `getFormattedMessages(level, clearAfter)` - Returns truncated, formatted output

---

### `src/helpers.js` (In-page Interaction Helpers)

**Role**: Static JavaScript helpers executed inside the page for the interaction tools

**Security model**: Every helper is a STATIC function string passed to `Runtime.callFunctionOn` as `functionDeclaration`. User-supplied values (CSS selectors, typed text) are always passed separately via the CDP `arguments` array — never concatenated into JavaScript source. This makes selector/text-based code injection impossible.

**In-page helpers (IN_PAGE)**:
- `queryElement(selector)` - `document.querySelector`
- `isElementVisible()` - display/visibility/opacity/zero-size check
- `scrollIntoView()` - centers element in viewport
- `getClickablePoint()` - viewport coords + coverage check
- `focusElement()` - focus input/textarea/contenteditable
- `isTypeable()` - is input/textarea/contenteditable
- `clearInput()` - native-setter clear + input/change events
- `typeText(text)` - character-by-character typing with events
- `findTextInPage(text)` - innerText search, whitespace-normalized
- `normalizeWhitespace(text)` - whitespace normalization
- `getElementInfo()` - read back tag/value/text

**Node-side runners** (used by index.js):
- `clickElement(browser, selector, timeoutMs)` - wait → visible → scroll → point → `Input.dispatchMouseEvent` (mousemove/press/release)
- `typeIntoElement(browser, selector, text, {clearFirst, timeoutMs})` - wait → typeable check → focus → clear → type
- `waitForCondition(browser, {selector, text, timeoutMs})` - poll until both conditions met (100ms interval)
- `queryElement`, `waitForElement`, `isElementVisible`, `scrollIntoView`, `getClickablePoint`, `focusElement`, `isTypeable`, `clearInput`, `typeText`, `findTextInPage`, `waitForText`, `getElementInfo`, `normalizeWhitespace`

---

### `src/lock.js` (Operation Lock)

**Role**: Single mutex serializing state-changing browser operations

**Features**:
- FIFO queue capped at `CONFIG.QUEUE_LIMIT` (8) — rejects with `BUSY_QUEUE_FULL` when full
- `queueLength` includes the active operation
- Watchdog force-releases after `maxDurationMs` (default 5 min) to prevent deadlocks
- Release via returned function; callers use try/finally so it releases on success, error, and timeout

**Key Methods**:
- `acquire()` - resolve with release function, or reject BUSY_QUEUE_FULL
- `withLock(lock, fn)` - run fn, guarantee release

---

### `src/utils.js` (Utilities)

**Role**: Validation, truncation, and error formatting

**Responsibilities**:
- URL validation (scheme whitelist, private IP blocking)
- Path traversal prevention for screenshot output
- Timeout capping (min 100ms, max 120s)
- Text/buffer truncation for oversized responses
- MCP error/result formatting

**Key Functions**:
- `validateURL(url, options)` - Validates URL scheme and host
- `validateSafePath(inputPath, outputDir)` - Prevents path traversal attacks
- `capTimeout(ms, default)` - Enforces timeout bounds
- `truncateText(text, max)` - Truncates long text responses
- `truncateBuffer(buffer, max)` - Truncates large binary data
- `truncateConsole(lines, max)` - Truncates console output
- `isPrivateIP(hostname)` - Detects private network addresses

**Security Rules**:
- Rejects `file:`, `javascript:`, `data:`, `vbscript:` schemes
- Blocks private IPs by default (10.x, 192.168.x, 172.x, .local, .internal)
- Prevents absolute paths and `..` traversal in screenshot filenames
- Enforces screenshot output stays within `OUTPUT_DIR`

**Constants**:
- `MAX_TIMEOUT_MS` - 120,000ms (2 minutes)
- `DEFAULT_TIMEOUT_MS` - 30,000ms (30 seconds)
- `MAX_TEXT_LENGTH` - 1,000,000 characters
- `MAX_IMAGE_BYTES` - 10,000,000 bytes (10 MB)
- `MAX_CONSOLE_LINES` - 500 lines
- `QUEUE_LIMIT` - 8 concurrent operations

---

## Dependency Map

### Call Graph

```
index.js (MCP Server)
├── Imports Browser from src/browser.js
├── Imports utils from src/utils.js
├── Tool: browser_navigate
│   ├── ensureBrowserReady() → Browser.start()
│   ├── validateURL() → src/utils.js
│   ├── Browser.send('Page.navigate')
│   ├── Browser.cdp.on('Page.loadEventFired')
│   ├── Browser.send('Runtime.evaluate')
│   └── resetIdleTimer()
├── Tool: browser_get_text
│   ├── ensureBrowserReady()
│   ├── Browser.send('Runtime.evaluate')
│   ├── truncateText() → src/utils.js
│   └── resetIdleTimer()
├── Tool: browser_screenshot
│   ├── ensureBrowserReady()
│   ├── validateSafePath() → src/utils.js
│   ├── Browser.send('Page.getLayoutMetrics')
│   ├── Browser.send('Page.captureScreenshot')
│   └── resetIdleTimer()
├── Tool: browser_get_console
│   ├── ensureBrowserReady()
│   ├── Browser.consoleBuffer.getFormattedMessages()
│   └── resetIdleTimer()
└── Tool: browser_snapshot
    ├── ensureBrowserReady()
    ├── Browser.send('Accessibility.getFullAXTree')
    ├── Browser.send('DOM.describeNode')
    ├── Browser.send('Runtime.evaluate')
    └── resetIdleTimer()

src/browser.js (Browser)
├── Imports CDPClient from src/cdp.js
├── Imports ConsoleBuffer from src/console-buffer.js
├── Imports utils from src/utils.js
├── start()
│   ├── findChromiumPath()
│   ├── spawn() → Chromium process
│   ├── _waitForDevToolsPort()
│   ├── _connectToPage()
│   │   ├── new CDPClient()
│   │   ├── CDPClient.connect()
│   │   ├── _enableDomains() → CDPClient.send()
│   │   └── _setupConsoleListeners()
│   └── state = READY
├── send() → CDPClient.send()
├── _setupConsoleListeners()
│   ├── CDPClient.on('Runtime.consoleAPICalled') → ConsoleBuffer.add()
│   ├── CDPClient.on('Runtime.exceptionThrown') → ConsoleBuffer.add()
│   └── CDPClient.on('Page.frameNavigated') → ConsoleBuffer.clear()
└── cleanup()
    ├── CDPClient.close()
    ├── process.kill()
    └── rmSync(profileDir)

src/cdp.js (CDPClient)
├── Imports utils from src/utils.js
├── connect() → WebSocket connection
├── send() → WebSocket.send()
├── _handleMessage()
│   ├── Routes responses to pending requests
│   └── Emits CDP events
└── close() → WebSocket.close()

src/console-buffer.js (ConsoleBuffer)
└── Imports utils from src/utils.js
    └── getFormattedMessages() → truncateConsole()
```

### Data Flow

```
User Request (MCP JSON-RPC)
    ↓
index.js (Tool Handler)
    ↓
ensureBrowserReady()
    ↓ (if not ready)
Browser.start()
    ↓
spawn Chromium → DevToolsActivePort → CDP WebSocket
    ↓
Browser.send(CDP method)
    ↓
CDPClient.send() → WebSocket
    ↓
Chromium executes → WebSocket response
    ↓
CDPClient._handleMessage() → resolve Promise
    ↓
Tool Handler processes result
    ↓
validateURL() / validateSafePath() / truncateText()
    ↓
MCP Response (JSON-RPC)
```

---

## Critical Rules

### DO NOT MODIFY DIRECTLY

1. **`src/cdp.js` request/response correlation**
   - The `pending` Map and `nextId` counter are critical for CDP protocol correctness
   - Changing ID generation or correlation logic will break all CDP commands

2. **`src/browser.js` state machine**
   - State transitions (STOPPED → STARTING → READY → etc.) must follow the defined order
   - Skipping states or allowing invalid transitions will cause race conditions

3. **`src/utils.js` security validations**
   - `validateURL()` scheme whitelist prevents SSRF attacks
   - `validateSafePath()` prevents directory traversal attacks
   - `isPrivateIP()` blocks access to internal networks
   - **Never relax these without explicit security review**

4. **`index.js` navigation state tracking**
   - `navigationPromise` prevents race conditions between concurrent tool calls
   - Removing this will cause text/screenshot operations to fail during navigation

5. **Console buffer clearing on navigation**
   - `Page.frameNavigated` listener clears buffer on main-frame navigation
   - Removing this will cause stale console messages to appear

### MODIFICATION GUIDELINES

- **Adding new tools**: Follow the pattern in `index.js` (validate → ensureBrowserReady → send CDP → resetIdleTimer)
- **Changing timeouts**: Update `CONFIG` in `src/utils.js`, not hardcoded values
- **Adding CDP domains**: Update `_enableDomains()` in `src/browser.js`
- **Changing screenshot output**: Update `OUTPUT_DIR` env var, not the path validation logic
- **Modifying console buffer size**: Update `CONFIG.MAX_CONSOLE_MESSAGES` in `src/utils.js`

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHROMIUM_PATH` | (auto-detect) | Path to Chromium binary |
| `OUTPUT_DIR` | `./screenshots` | Screenshot output directory |
| `IDLE_SHUTDOWN_MS` | `300000` (5 min) | Idle timeout before browser shutdown (`0` disables) |
| `ALLOW_PRIVATE_NETWORKS` | `0` | Allow private IP URLs (1 = allow) |
| `NAVIGATION_TIMEOUT_MS` | `30000` | Default navigate timeout |
| `TOOL_TIMEOUT_MS` | `10000` | Default click/type/get_text timeout |
| `MAX_TIMEOUT_MS` | `120000` | Hard timeout cap |
| `MAX_TEXT_LENGTH` | `1000000` | get_text truncation limit |
| `MAX_IMAGE_BYTES` | `10000000` | Image payload cap |
| `MAX_CONSOLE_LINES` | `500` | Console output limit |
| `MAX_CONSOLE_MESSAGES` | `500` | Console ring buffer size |
| `MAX_SNAPSHOT_ITEMS` | `100` | Snapshot default limit |
| `MAX_SCREENSHOT_PIXELS` | `16000000` | Screenshot area cap |
| `MAX_EVAL_LENGTH` | `100000` | browser_evaluate expression/result length cap |
| `ENABLE_EVAL_JS` | `0` | Enable the browser_evaluate tool (disabled by default) |
| `QUEUE_LIMIT` | `8` | Operation lock queue size |

See `.env.example` for the full documented list (including reserved variables). Priority: tool argument → env var → default → hard limit.

---

## MCP Tools

### 1. `browser_navigate`
- **Input**: `url` (string), `timeout_ms` (optional, default 30000)
- **Output**: `{ url, title, status }`
- **CDP Commands**: `Page.navigate`, `Runtime.evaluate`
- **Events**: `Page.loadEventFired`, `Page.frameNavigated`, `Network.responseReceived`
- **Same-document (hash) navigation**: detected by comparing origin+pathname before navigating; handled via `Page.navigatedWithinDocument` (never waits for `loadEventFired`). After the event fires the handler waits ~200ms + double-rAF (`waitForSettle`) so the browser's built-in anchor scroll settles and the compositor produces a valid frame — a screenshot in the next tool call is not blank

### 2. `browser_get_text`
- **Input**: `selector` (optional), `timeout_ms` (optional, default 10000)
- **Output**: `{ text, truncated, length }`
- **CDP Commands**: `Runtime.evaluate`
- **Behavior**: with a selector, form elements (`input`/`textarea`/`select`) return their `value` property (typed/selected content — `innerText` would be empty for these); all other elements return `innerText`. Without a selector, returns `document.body.innerText`

### 3. `browser_screenshot`
- **Input**: `filename` (optional), `format` (jpeg/png), `quality` (1-100), `full_page` (boolean), `delay_ms` (0-5000, optional, default 0)
- **Output**: `{ path, size, truncated }` + image data
- **CDP Commands**: `Page.getLayoutMetrics`, `Page.captureScreenshot`, `Runtime.evaluate` (warm-up scroll), `Emulation.setDeviceMetricsOverride` / `clearDeviceMetricsOverride`
- **Security**: Path traversal validation, pixel limit (16M pixels)
- **Full-page behavior**: (1) warm-up scroll through the page in viewport-sized steps so IntersectionObserver/lazy-rendered sections paint; (2) re-read layout metrics; (3) oversized pages are downscaled via `clip.scale` (full page at lower resolution — never cropped); (4) a temporary full-height viewport override (`Emulation.setDeviceMetricsOverride`) is applied before capture and ALWAYS reset in a `finally` block; (5) `delay_ms > 0` waits before capturing; full-page captures are serialized behind the operation lock
- **Viewport behavior**: no `clip` is passed to `Page.captureScreenshot` — an explicit clip with `captureBeyondViewport: false` captures a blank (white/black) frame when the page is scrolled (clip coordinates are page-space and the scrolled surface is never produced). Without a clip, Chromium captures the current viewport at the current scroll position correctly

### 4. `browser_get_console`
- **Input**: `level` (all/error/warning/log/info/debug), `clear_after` (boolean)
- **Output**: `{ messages, count, cleared, truncated, droppedCount }`
- **Source**: `ConsoleBuffer` (populated by `Runtime.consoleAPICalled` events)

### 5. `browser_snapshot`
- **Input**: `include_text` (boolean), `max_items` (max 200, default 100)
- **Output**: `{ elements, count, truncated }`
- **CDP Commands**: `Accessibility.getFullAXTree`, `DOM.describeNode`, `Runtime.evaluate`
- **Purpose**: Returns interactive elements with selectors for automation

### 6. `browser_click`
- **Input**: `selector` (string), `force` (boolean, default false), `timeout_ms` (optional, default 10000, max 120000)
- **Output**: `{ clicked: true, selector, x, y, forced? }`
- **CDP Commands**: `Runtime.callFunctionOn` (helpers), `Input.dispatchMouseEvent` (mousemove/mousePressed/mouseReleased)
- **Behavior**: waits for element → checks visibility → scrolls into view (`behavior: 'instant'`, then ~100ms + double-rAF settle; the clickable point is re-read once if the first read reports the element covered, so below-viewport / sticky-header elements click cleanly without `force`) → multi-point hit test (center + 4 quadrants; a free quadrant is used when the center is covered by an overlay) → real mouse click (not JS `.click()`); with `force: true`, a fully covered element falls back to JavaScript `.click()` and returns `forced: true`; post-click render settle (~100ms + double rAF) so immediate screenshots are not blank
- **Errors**: `ELEMENT_NOT_FOUND` (timeout), `ELEMENT_HIDDEN`, `ELEMENT_NOT_CLICKABLE` (covered, no force), invalid selector → SyntaxError
- **Locked**: yes (state-changing)

### 7. `browser_type`
- **Input**: `selector` (string), `text` (string), `clear_first` (boolean, default true), `timeout_ms` (optional, default 10000)
- **Output**: `{ typed: true, selector, length, finalLength }`
- **CDP Commands**: `Runtime.callFunctionOn` (focus/clear/type helpers)
- **Behavior**: waits for element → verifies typeable (input/textarea/contenteditable) → focuses → optionally clears → types character-by-character dispatching input/change events (native value setter for inputs, `execCommand('insertText')` for contenteditable)
- **Errors**: `ELEMENT_NOT_FOUND`, `ELEMENT_NOT_TYPEABLE`
- **Locked**: yes (state-changing)
- **Security**: the typed `text` is NEVER logged (may contain passwords/tokens)

### 8. `browser_wait_for`
- **Input**: `selector` (optional string), `text` (optional string), `timeout_ms` (optional, default 15000, max 120000)
- **Output**: `{ found: true, selector, text, elapsed_ms }`
- **CDP Commands**: `Runtime.callFunctionOn` (queryElement, findTextInPage)
- **Behavior**: polls every 100ms until selector exists and/or text appears (whitespace-normalized literal matching, no diacritic normalization); at least one of selector/text required
- **Errors**: `INVALID_ARGS` (neither given), `TIMEOUT`
- **Locked**: no (read-only polling)

### 9. `browser_scroll`
- **Input**: `direction` (up/down/left/right/top/bottom, optional), `selector` (optional), `x`/`y` (optional), `pixels` (optional) — exactly one mode required
- **Output**: `{ scrollX, scrollY, mode, ... }`
- **CDP Commands**: `Runtime.callFunctionOn` (scrollByDirection / scrollToPosition / scrollIntoView + isInViewport)
- **Behavior**: Mode A scrolls by direction (default 80% of viewport dimension, or exact `pixels`); Mode B scrolls a selector into view and verifies viewport presence; Mode C scrolls to absolute `x`/`y`. Always `behavior: 'instant'` — no smooth-scroll animation. Every runner waits ~100ms + double-rAF (`waitForSettle`) before returning so the compositor has produced a valid frame — a screenshot in the next tool call shows the scrolled content, not a blank frame
- **Errors**: `INVALID_ARGS` (no mode, conflicting modes, or x without y), `ELEMENT_NOT_FOUND` (selector mode)
- **Locked**: no (viewport read/write, not DOM state)

### 10. `browser_resize`
- **Input**: `preset` (`mobile`|`tablet`|`desktop`, optional), `width`/`height` (100–10000, optional), `device_scale_factor` (1–4, optional), `mobile` (boolean, optional), `reset` (boolean, optional), `timeout_ms` (optional)
- **Output**: `{ resized: true, width, height, deviceScaleFactor, mobile, preset, reset }`
- **CDP Commands**: `Emulation.setDeviceMetricsOverride` / `Emulation.clearDeviceMetricsOverride`
- **Behavior**: three exclusive modes — `reset`, a named `preset`, or explicit `width`+`height`. Validation runs on the RAW arguments in `src/viewport.js` (`resolveViewportParams`), never on a Zod-normalized object — Zod `.default()` values would otherwise make `reset` impossible to distinguish from a default and hide an empty `{}` call. The applied viewport is stored on `Browser.viewport` (survives idle shutdown and is re-applied after a restart/reconnect) and a double-rAF settle follows. Presets: mobile `390×844 @3 mobile`, tablet `768×1024 @2 mobile`, desktop `1280×800 @1`.
- **Errors**: `INVALID_ARGS`, `VIEWPORT_APPLY_FAILED`
- **Locked**: yes

### 11. `browser_evaluate`
- **Input**: `expression` (string, required, ≤ `MAX_EVAL_LENGTH`), `await_promise` (default true), `user_gesture` (default false), `timeout_ms` (default 10000)
- **Output**: `{ result, type, truncated }`
- **CDP Commands**: `Runtime.evaluate`, `Runtime.callFunctionOn` (`IN_PAGE.serializeValue`), `Runtime.releaseObject`
- **Behavior**: **disabled by default** — refused with `EVAL_DISABLED` before the browser starts unless `ENABLE_EVAL_JS=1`. Primitives are returned directly; object/function/DOM results are serialized in-page by the static `IN_PAGE.serializeValue` helper (cycles, depth `4`, `100` properties, Date/Error/Element/Map/Set/BigInt/Symbol), and the remote handle is always released. The serialized result is JSON-stringified and truncated to `MAX_EVAL_LENGTH`.
- **Errors**: `EVAL_DISABLED`, `EVAL_ERROR` (in-page exception), `TIMEOUT`
- **Locked**: yes (arbitrary JS can mutate the DOM)
- **Security**: when enabled the page code can read cookies/localStorage and issue `fetch()` to internal networks (SSRF), bypassing the navigation-only `validateURL` check — see the Security Model

### 12. `browser_hover`
- **Input**: `selector` (string, required), `timeout_ms` (optional, default 10000)
- **Output**: `{ hovered: true, selector, x, y, matchesHover }`
- **CDP Commands**: `Runtime.callFunctionOn` (`isElementVisible`, `scrollIntoView`, `getClickablePoint`, `isHovered`), `Input.dispatchMouseEvent` (`mouseMoved`)
- **Behavior**: waits for element → visibility → scroll into view (`instant` + settle) → resolve an unobstructed point (center + quadrants) → move the real mouse. If `:hover` does not engage on the first move, a nudge (away, then back) is attempted. `matchesHover` reports the final `matches(':hover')` state — diagnostic, not an error.
- **Errors**: `ELEMENT_NOT_FOUND`, `ELEMENT_HIDDEN`
- **Locked**: yes (hover can open menus)

### 13. `browser_press`
- **Input**: `key` (string, required), `modifiers` (`Alt`|`Control`|`Meta`|`Shift`[], default `[]`), `selector` (optional — focused first), `repeat` (1–100, default 1), `timeout_ms` (optional, default 10000)
- **Output**: `{ pressed: true, key, modifiers, count, selector, focused }`
- **CDP Commands**: `Input.dispatchKeyEvent` (`keyDown` with text for printable keys, `rawKeyDown` otherwise, then `keyUp`)
- **Behavior**: resolves the key via `src/keymap.js` (`resolveKey`, throws `KEY_NOT_SUPPORTED` for unknown keys); with a selector it scrolls/focuses the element first. Enter/Tab/Space carry text so keypress/default actions fire (form submit, focus traversal). Always sends `keyUp`, then settles before returning.
- **Errors**: `KEY_NOT_SUPPORTED`, `INVALID_ARGS`, `ELEMENT_NOT_FOUND`, `ELEMENT_HIDDEN`
- **Locked**: yes
- **Security**: a single-character key is logged as `<char>`, never its value

---

## Testing Strategy

- **Unit tests**: `node --test tests/*.test.js`
- **Integration tests**: `integration.test.js`, `interaction.test.js`, `reading-tools.test.js`, `resize.test.js`, `evaluate.test.js`, `hover-press.test.js`, `screenshot-limits.test.js` (spawn real Chromium)
- **Test fixture**: `fixtures/test-page.html`, `fixtures/page2.html`; shared integration harness in `tests/harness.js`

**Test Coverage**:
- URL validation (scheme, private IP, edge cases)
- Path traversal prevention
- CDP request/response correlation
- Browser lifecycle (start, crash, restart, cleanup)
- Console buffer (add, clear, truncate, filter)
- MCP tool functionality
- Interaction tools (click/type/wait_for/scroll) incl. Arabic text and lock serialization
- Resize (explicit/preset/reset, persistence across navigation, survival of full_page capture)
- Evaluate (gate disabled, primitives/objects/DOM/cycles/promises/exceptions, truncation)
- Hover and key press (Enter form submit, Tab focus, Escape, modifiers, unsupported keys)
- Screenshot limits (post-capture downscaling, mobile page scale, tall pages)
- Operation lock (FIFO, queue limit, release on error/timeout)
- Security (selector/text injection resistance, no sensitive logging)

---

## Performance Characteristics

- **Startup time**: ~1-3 seconds (Chromium spawn + CDP connection)
- **Memory**: ~50-100 MB (headless Chromium)
- **Screenshot limit**: 16M pixels (auto-scaled if exceeded)
- **Text limit**: 1M characters (auto-truncated)
- **Console buffer**: 500 messages (ring buffer)
- **Idle shutdown**: 5 minutes (configurable)
- **Max timeout**: 120 seconds
- **Concurrent operations**: State-changing ops (click/type/navigate/full-page screenshot) serialized by the operation lock (queue limit 8); reading ops wait for in-flight navigation

---

## Security Model

1. **URL Validation**: Whitelist of schemes (http, https, about), blocks private IPs
2. **Path Traversal**: Prevents `..` and absolute paths in screenshot filenames
3. **Output Isolation**: Screenshots confined to `OUTPUT_DIR`
4. **Resource Limits**: Timeouts, text truncation, pixel limits
5. **Gated JS execution**: no arbitrary-JS tool runs by default — `browser_evaluate` is refused (`EVAL_DISABLED`) unless `ENABLE_EVAL_JS=1`. When enabled it can read cookies/localStorage and reach internal networks via in-page `fetch()` (SSRF), bypassing the navigation-only `validateURL` check. No other tool executes user-supplied JavaScript.
6. **Measured screenshot limits**: after each capture the real image dimensions are decoded from the buffer and the byte size checked; oversized captures are downscaled via `clip.scale` (never cropped) and re-captured once, or fail with `SCREENSHOT_TOO_LARGE`.

---

## Failure Modes

1. **Chromium not found**: Throws error, suggests setting `CHROMIUM_PATH`
2. **CDP connection timeout**: Fails after 10s, browser state → FAILED
3. **Navigation timeout**: Throws error, browser remains ready
4. **Crash during operation**: Auto-restart (up to 2 times), then state → FAILED
5. **Idle timeout**: Graceful shutdown after 5 min inactivity
6. **Screenshot path traversal**: Returns error, no file written
7. **URL scheme violation**: Returns error, no navigation attempted
