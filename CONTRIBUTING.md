<!-- Contributing guide for browser-mcp. Verified against package.json, ARCHITECTURE.md, and the test suite. -->

# Contributing to browser-mcp

> Thank you for taking the time to contribute. Whether it is a typo fix, a new tool, or a hardened edge case, every contribution makes this project better for everyone using a browser through an AI assistant.

**[README](README.md)** · **[Architecture](ARCHITECTURE.md)** · **[Security](#security-rules-non-negotiable)** · **[Testing](#testing)** · **[Pull requests](#commit-and-pull-request-guidelines)** · **[License](#license)**

---

## Why This Project Is Worth Contributing To

browser-mcp is a small, deliberately thin MCP server — and that thinness is the point. It is a codebase where a well-placed change has an outsized effect, and where the design decisions are explicit enough to reason about rather than guess at.

- **Raw CDP, three dependencies** — the protocol is spoken directly over a WebSocket, with no Puppeteer or Playwright layer to install, pin, or debug. The runtime surface is `@modelcontextprotocol/sdk`, `ws`, and `zod`.
- **19 tools, one consistent pattern** — every tool follows the same validate → ready → act → reset flow, so a new tool reads like the ones already there.
- **303 tests across 25 files** (`node:test`, no external framework) — unit tests for validation and the operation lock, and integration tests that spawn real Chromium and assert on pixels.
- **ARM64-native and resource-minded** — developed and verified on aarch64, with lazy browser start, idle shutdown, a bounded operation queue, and a stress test for start/stop cycles.
- **Security-first defaults** — arbitrary JavaScript evaluation and the WebGL stand-in are both opt-in and refused by default; selectors and typed text are never concatenated into page JavaScript.
- **The hard edges are already documented** — blank screenshots on scrolled pages, stale frames, hash-only navigation, crash restarts that keep the profile, and overlay-covered clicks each have a test and a paragraph explaining the fix.

If you are looking for a concrete entry point, see [Good First Contributions](#good-first-contributions).

---

## Code of Conduct

This project expects respectful, constructive collaboration. In short:

- Be welcoming to people of every background and experience level.
- Critique code and ideas, not people.
- Assume good faith, ask questions before assuming a mistake, and keep discussions on the technical merits.
- Harassment, discrimination, and personal attacks are not tolerated in issues, pull requests, or any project space.

If you experience or witness unacceptable behavior, please open a private channel with the maintainers (or a minimal issue asking for a private contact) and it will be handled promptly.

---

## Ways to Contribute

| Area | What helps |
|------|------------|
| **Bug reports** | A minimal reproduction: the tool called, the arguments, the observed vs. expected result, and the version from `package.json` |
| **Feature requests** | The problem you are solving, not only the solution you have in mind |
| **Documentation** | Fixing stale claims in `README.md` or `ARCHITECTURE.md`, clarifying a tool's behavior, adding a real example |
| **Tests** | Coverage for an untested edge case — a scroll semantics corner, a crash-recovery path, a limit boundary |
| **Code** | Bug fixes, new tools, and improvements to the CDP client, browser lifecycle, or in-page helpers |
| **Triage** | Reproducing reported issues and confirming which ones still apply |

---

## Development Setup

### Prerequisites

- **Node.js ≥ 20** (verified on v26.2.0) and **npm** (verified on 11.13.0)
- **Chromium or Google Chrome** — required for integration tests. The server auto-detects `/usr/bin/chromium-browser`, `/usr/bin/chromium`, `/usr/bin/google-chrome`, or `/usr/bin/google-chrome-stable`; otherwise set `CHROMIUM_PATH`.
- On Debian/Ubuntu, `./install-chromium.sh` installs a compatible build (idempotent; `--dry-run` to preview, `--uninstall` to remove the apt source and pin it created).
- No API keys or external services are required — everything runs locally.

### Get the code

```bash
git clone https://github.com/amjdcodes/browser-mcp.git
cd browser-mcp
npm install
```

### Verify your setup

```bash
# Chromium is reachable
chromium --headless --no-sandbox --dump-dom about:blank

# The suite passes (303 tests across 25 files; integration tests spawn real Chromium)
npm test
```

There is no lint, typecheck, or build step — `node --test` runs the sources directly.

---

## Project Layout

```
browser-mcp/
├── index.js                  # MCP server entry point: 19 tool registrations, lock, idle timer
├── src/
│   ├── browser.js            # Chromium lifecycle: spawn, CDP connect, reconnect, crash restart, cleanup
│   ├── cdp.js                # Raw CDP WebSocket client (request/response correlation, events)
│   ├── helpers.js            # In-page helpers (IN_PAGE) + node-side runners
│   ├── webgl.js              # Static WebGL shim sources, trace expressions, console classification
│   ├── keymap.js             # Key resolution for browser_press
│   ├── viewport.js           # Viewport presets + raw resize-argument validation
│   ├── lock.js               # FIFO operation lock with queue limit and watchdog release
│   ├── console-buffer.js     # In-memory ring buffer for console messages
│   └── utils.js              # URL/path validation, truncation, decodeImageSize, capability gates, CONFIG
├── tests/                    # 303 tests across 25 files (node:test + node:assert/strict)
│   └── harness.js            # Shared harness: fixture server, MCP child, buffered JSON-RPC
├── fixtures/                 # Test HTML pages (interactive, lazy, tall, RTL, WebGL)
├── screenshots/              # Screenshot output directory (runtime; override with OUTPUT_DIR)
├── stress-test.sh            # Start/stop cycles: Chromium leak + RSS growth check
├── install-chromium.sh       # Installs Chromium (Debian archive on Ubuntu, APT-pinned)
├── .env.example              # Reference for every environment variable (not auto-loaded)
├── ARCHITECTURE.md           # Deeper architecture, call graph, and per-tool reference
└── README.md                 # User-facing documentation
```

---

## Architecture at a Glance

browser-mcp is a thin, layered server. Keep new code inside the right layer:

| Layer | Responsibility | Key components |
|-------|----------------|----------------|
| Interface | MCP tool registration and orchestration | `index.js` |
| Orchestration | Serialize and track operations; idle lifecycle | operation lock, idle timer, navigation guard |
| Service | Drive Chromium over CDP and run in-page helpers | `src/browser.js`, `src/cdp.js`, `src/helpers.js` |
| Infrastructure | Browser process, profile, on-disk output | `src/browser.js`, `src/utils.js` |

The full call graph and the per-tool CDP command list live in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Ground Rules

These are the load-bearing parts of the codebase — changes to them need a clear reason and a test.

1. **CDP request/response correlation (`src/cdp.js`)** — the `pending` map and `nextId` counter are what make every CDP command resolve correctly. Do not change the ID or correlation scheme casually.
2. **The browser state machine (`src/browser.js`)** — transitions (`STOPPED → STARTING → READY → …`) must follow the defined order. Skipping or reordering states causes races between navigation, restart, and tool calls.
3. **Security validations (`src/utils.js`)** — `validateURL()` (scheme whitelist + private-IP blocking), `validateSafePath()` (traversal prevention), and `isPrivateIP()`. Never relax these without an explicit security rationale in the pull request.
4. **Navigation state tracking (`index.js`)** — `navigationPromise` prevents reading tools from racing an in-flight navigation. Removing it makes text and screenshot calls fail mid-navigation.
5. **Console buffer clearing** — the `Page.frameNavigated` listener clears the buffer on main-frame navigation. Without it, stale console output leaks into later calls.

---

## Coding Standards

- **Match the existing style.** The codebase is ESM (`"type": "module"`), uses `const`/`let`, and favors small, named functions. There is no linter to enforce it — consistency is the standard.
- **Respect module boundaries.** `index.js` stays orchestration + registration. Each `src/` module owns its own layer and does not reach across.
- **Centralize tunables in `CONFIG`** (`src/utils.js`) rather than hardcoding timeouts, limits, or buffer sizes. New environment variables belong in `.env.example` and the README configuration table.
- **Return structured error codes.** Tools surface stable, greppable codes (`ELEMENT_NOT_FOUND`, `ELEMENT_HIDDEN`, `ELEMENT_NOT_CLICKABLE`, `ELEMENT_NOT_TYPEABLE`, `BUSY_QUEUE_FULL`, `EVAL_DISABLED`, `UNSAFE_PATH`, `SCREENSHOT_TOO_LARGE`, …). Add a new code rather than overloading an existing one.
- **Keep the protocol clean.** All logging goes to **stderr**; stdout is reserved for MCP JSON-RPC. A stray `console.log` will corrupt the stream.
- **No new dependencies without discussion.** Three runtime dependencies is a feature. Open an issue first if you think a fourth is needed.

---

## Adding a New Tool

Follow the pattern already used by the 19 existing tools:

1. **Declare the tool** in `index.js` with a name, description, and a **Zod input schema** (with sensible defaults, documented ranges).
2. **Validate the raw arguments** before touching the browser. Validate the arguments you actually received — not a defaulted object — so that "omitted" and "explicitly default" stay distinguishable (this matters for mutually exclusive modes; see `src/viewport.js`).
3. **Guard the capability** if the tool executes user-influenced code or changes browser-global behavior. Opt-in features read their flag through the capability gates in `src/utils.js` and refuse with a dedicated code (`EVAL_DISABLED`, `WEBGL_SHIM_DISABLED`) before the browser even starts.
4. **Ensure readiness** via `ensureBrowserReady()`, then issue the CDP or `Runtime` work.
5. **Decide on the lock.** If the operation changes page state, navigate, or capture a full page, run it behind `runLocked()` so it serializes against other state-changing calls.
6. **Reset the idle timer** by ending through the existing `withActivityTracking` / `resetIdleTimer` path, so a call always counts as activity.
7. **Settle before returning** if the result is visual. Scrolls, clicks, hash navigation, and viewport changes wait ~100 ms + double-rAF (`waitForSettle`) so the compositor produces a valid frame for the next screenshot.
8. **Emit a bounded, documented result** — truncate large payloads, cap list sizes, and decode real image dimensions instead of trusting estimates.
9. **Add tests** (see [Testing](#testing)), and update `README.md`, `ARCHITECTURE.md`, and `.env.example` if behavior or configuration changed.

---

## Security Rules (Non-Negotiable)

- **Never build JavaScript from user input.** CSS selectors and typed text are always passed to `Runtime.callFunctionOn` as CDP `arguments` values — never interpolated into a `functionDeclaration` string. This is what makes injection impossible; an injected static helper must stay static.
- **Never log sensitive input.** `browser_type` never logs the typed text (it may be a password or token), and `browser_press` logs a single-character key as `<char>`.
- **Keep privileged tools gated and opt-in.** `browser_evaluate` and `browser_webgl_shim` are disabled by default and must stay that way. Any result produced by the WebGL shim is marked `shimmed: true` — it records calls, it does not rasterize.
- **Enforce output boundaries.** Screenshots stay inside `OUTPUT_DIR`; filenames are validated against traversal. Do not bypass path validation to make a test pass.
- **Never commit secrets or generated artifacts.** `.env` files, credentials, and screenshots do not belong in version control.

---

## Testing

```bash
# Full suite — 303 tests across 25 files
npm test

# A single file while iterating
node --test tests/interaction.test.js

# Low-RAM devices: one file at a time, bounded concurrency
node --test --test-concurrency=1 tests/resize.test.js
```

`npm test` runs `node --test --test-concurrency=3 tests/*.test.js`. Tests use the built-in runner with `node:assert/strict` — there is no framework to learn.

- **Integration tests spawn real Chromium**, so they require the browser to be installed.
- **On low-RAM machines**, run files one at a time with `--test-concurrency=1`; `memory.test.js` (50 start/stop cycles) is the heaviest — run it alone and last.
- **Add a fixture** under `fixtures/` when a test needs a page shape that does not exist yet, and reuse `tests/harness.js` for the fixture server, MCP child process, and buffered JSON-RPC.
- **Cover the failure path**, not only the happy path. A new tool should test its documented error codes and its limits — and any security-relevant change should include a test that proves injection or traversal is still rejected.
- **Check for leaks** when you touch lifecycle code: `./stress-test.sh` starts and stops the browser repeatedly and asserts no leaked Chromium processes and no RSS growth.

The suite must pass before a pull request is ready. If you cannot run a heavy integration test locally, say so in the pull request so a maintainer can run it.

---

## Commit and Pull Request Guidelines

### Branches

Use a short, descriptive branch name: `fix/blank-viewport-capture`, `feat/hover-tool`, `docs/contributing-guide`.

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/). The repository's history uses the same shape:

```
feat(tools): add 5 WebGL/canvas diagnostics and frame capture tools
fix(screenshot): pass no clip for viewport captures on scrolled pages
docs: add architecture diagram to README
test(lock): cover release-on-timeout
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`. Useful scopes: `tools`, `browser`, `cdp`, `lock`, `webgl`, `screenshot`, `docs`.

### Pull request checklist

Before you open the pull request, confirm:

- [ ] `npm test` passes, and heavy integration tests were run or their absence is noted.
- [ ] New behavior has tests, including its error and boundary paths.
- [ ] New or changed environment variables are documented in `.env.example` and the README.
- [ ] `README.md` / `ARCHITECTURE.md` are updated when behavior, tool inputs, or outputs changed.
- [ ] No new runtime dependency was added without prior discussion.
- [ ] No secrets, `.env` files, or generated screenshots are included.
- [ ] Selectors and text are passed as CDP `arguments`, never concatenated into JavaScript.
- [ ] All logging still goes to stderr.

In the description, explain **what** changed, **why**, and **how you tested it**. Link the issue it closes with `Closes #123`. Keep the pull request focused — one concern per pull request.

### Review expectations

Maintainers review for correctness first, then security, then consistency with the existing patterns. Expect questions about edge cases and test coverage; they are there to keep the thin stack thin and the behavior predictable.

---

## Reporting Bugs and Requesting Features

Open a GitHub issue and include:

**For a bug**
- What you did (the exact tool call and arguments)
- What you expected to happen
- What actually happened (the full error, including any `[ERROR_CODE]` prefix)
- Your environment: OS, architecture, Node version, Chromium version (from `package.json` and `chromium --version`)

**For a feature**
- The problem or workflow you are trying to solve
- The tool shape you imagine, if you have one
- Whether it can be expressed with the existing 19 tools first

Useful packet for hard-to-reproduce issues: run the server with stderr captured (`node index.js 2> server.log`) and attach the relevant lines. The server sends all diagnostics to stderr, and stdout only to MCP JSON-RPC.

---

## Good First Contributions

Small, well-scoped changes that are genuinely useful:

- Add a test for a documented error code that is currently only exercised indirectly.
- Add a fixture page for a layout the suite does not yet cover.
- Improve a tool description or a `reason`/`advice` string so a failure explains itself.
- Tighten a truncation boundary or add a boundary test at exactly the limit.
- Fix a stale or inaccurate claim in `README.md` or `ARCHITECTURE.md`.

---

## Documentation

Documentation is where contributors and users meet, and in this project it is treated as **claims about the code** — every statement must be true of the implementation.

- When you change behavior, grep the docs for the old symbol before you finish.
- Prefer a concrete example over an adjective: "downscaled via `clip.scale`, never cropped" beats "handles large pages well".
- Document the failure path, using the error codes the code actually raises.
- Keep the table of contents and internal anchors in sync with the headings.

---

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE), the same terms that cover the project.

---

Thank you for helping make browser-mcp better.
