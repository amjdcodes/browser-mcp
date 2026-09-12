I have all the evidence I need. Let me compile the final report.

---

## Review: browser-mcp codebase (CODE QUALITY)

Read-only review of all source files (index.js, src/browser.js, src/cdp.js, src/console-buffer.js, src/helpers.js, src/lock.js, src/utils.js), a skim of all 16 test files, and docs (AGENTS.md, ARCHITECTURE.md, README.md, .env.example). Note: `/root/browser-mcp/plan.md` and `progress.md` do not exist at the repo root; the plan is `markdown-files/PLAN.md`. The repo is **not under git** (no `.git`).

### What is good (with evidence)

- **Clean layered architecture** matching ARCHITECTURE.md: index.js (tools) → browser.js (lifecycle) → cdp.js (protocol) → helpers.js (in-page) → lock.js (serialization) → utils.js (validation). No framework dependency beyond `@modelcontextprotocol/sdk`, `ws`, `zod` (package.json).
- **Security model is genuinely implemented**: in-page helpers are static strings; user values (selectors, text) are passed only via the CDP `arguments` array, never concatenated into source (src/helpers.js:19-26, `IN_PAGE`), and helpers.test.js verifies no `${` interpolation exists in any helper. `validateURL` rejects `file:`/`javascript:`/`data:`/`vbscript:` and blocks private IPs (src/utils.js:38-64); `validateSafePath` blocks absolute paths and `..`; screenshot pixel cap enforced (index.js:389-405).
- **Error-code discipline** on interaction tools: `ELEMENT_NOT_FOUND`/`ELEMENT_HIDDEN`/`ELEMENT_NOT_CLICKABLE`/`ELEMENT_NOT_TYPEABLE`, `BUSY_QUEUE_FULL`, `CHROMIUM_RESTART_FAILED` with last stderr (index.js:713-732, browser.js:342-364).
- **Race guards that are actually correct**: state-transition checks before every reconnect/restart transition, plus "superseded" re-checks after async gaps (src/browser.js:316-333); `navigationPromise` handshake prevents read tools racing an in-flight navigation (index.js:274-277); `activeOperations` + timer reschedule keeps idle shutdown from interrupting work (index.js:118-135); the lock's FIFO/queue-cap/watchdog/`withLock` try-finally is correct (src/lock.js). The `restartAttempts` counter is only partially correct (see Finding 3).
- **Good failure hygiene**: `send()` rejects pending CDP requests on close (cdp.js:73-76), timeouts delete pending entries, dialog auto-dismiss prevents hangs (browser.js:233-241), SIGTERM→SIGKILL escalation + profile-dir removal with retries, `_cleanupDone` idempotency.
- **Tests**: 57/57 pure unit tests pass (`cdp`, `utils`, `lock`, `helpers` — verified by running them). The suite is broad: Arabic text typing, malicious-selector injection resistance, crash recovery, 50 start/stop cycles with RSS leak check, two parallel server instances, SIGTERM idempotency, idle-shutdown-doesn't-interrupt-in-flight.

### Issues found

**Blocker (critical):**
1. **`src/cdp.js:47,85-88` — unhandled `'error'` event crashes the whole MCP server.** `this.ws.on('error', …)` → `_handleError` → `this.emit('error', err)`, and nothing anywhere subscribes to the CDPClient's `'error'` event. Node's EventEmitter throws on `'error'` with no listeners → uncaught exception → process death. **Empirically reproduced**: `c.connect('ws://127.0.0.1:1/')` crashed the process with `throw er; // Unhandled 'error' event` at cdp.js:87, instead of rejecting the connect promise. Any WS connect failure (ECONNREFUSED, DNS/TLS) or future socket-error path kills the server and defeats the reconnect machinery. Fix: drop the `emit` (log only), or attach a no-op listener, or have browser.js subscribe.

**Medium:**
2. **`src/browser.js:395` — `readdirSync` is used but never imported** (imports at :1-3 lack it). `_killChildrenByProfile` throws `ReferenceError` which its inner `catch` silently swallows — **empirically confirmed no-op**. The orphan-Chromium-children killer (the mitigation for children recreating the profile dir) has never run. Cleanup depends only on `rmSync` retries. Fix: add `readdirSync` to the import, or remove the dead function.
3. **`src/browser.js:150` — `restartAttempts` reset on every successful `start()` defeats the crash-loop circuit breaker.** `_handleCrash` (browser.js:342-354) only trips FAILED when `start()` *throws*; a browser that starts OK but crashes repeatedly is restarted indefinitely (counter resets each cycle). ARCHITECTURE.md documents "auto-restart up to 2 times, then FAILED" — not what the code does for restart-success loops. The restart-limit test only covers `maxRestartAttempts: 0`.
4. **`src/browser.js:154-155` — FAILED state is lost on failed start.** `start()`'s catch sets `state = FAILED` then calls `cleanup()`, which ends at `STOPPED` (:489) without setting `failureReason`. Consequence: `ensureBrowserReady`'s FAILED branch (which surfaces `CHROMIUM_RESTART_FAILED` + stderr) is unreachable for start failures; every subsequent call silently retries a full `start()` (paying 30s+10s). Contradicts ARCHITECTURE.md "CDP connection timeout → state FAILED".
5. **`src/browser.js:440-445` — fixed 5s stall in every crash-restart.** In the crash path the process is already dead, so `this.process.once('exit', resolve)` never fires and cleanup always burns the full 5s timeout. Check `this.process.exitCode !== null` before waiting.
6. **`src/utils.js:131` — `truncateBuffer`/`MAX_IMAGE_BYTES` are dead in production.** The screenshot handler (index.js) never caps payload size; ARCHITECTURE.md and `.env.example` claim a 10 MB "image payload cap" that is not enforced.
7. **Doc drift.** AGENTS.md:24 says 5 tools; index.js registers 8. ARCHITECTURE.md:101 claims `detached: true`/"own process group"; code uses `detached: false` (browser.js:121). ARCHITECTURE.md's call graph omits `browser_click`/`browser_type`/`browser_wait_for` and the helpers.js/lock.js edges, and its test-file list omits 7 of the 16 test files.

**Low:**
8. **`index.js:32` — `IDLE_SHUTDOWN_MS` parsed with bare `parseInt` (no validation).** A malformed value → `NaN` → `setTimeout(..., NaN)` fires immediately → idle-shutdown loop. (`utils.envInt` validates; index.js doesn't.)
9. **`index.js:539` — `max_items` has no `.min`**; `0`/negative → `truncated: true` with 0 elements.
10. **Inconsistent error formatting in index.js** — get_text/screenshot/console/snapshot return bare `err.message`; click/type/wait/navigate use `formatToolError` with `[CODE]` prefixes (e.g., get_text's "Element not found" loses its `ELEMENT_NOT_FOUND` code).
11. **`src/cdp.js` `close()` can hang forever** on a peer that never completes the close handshake (no `terminate()`/close-timeout fallback), which would block `browser.cleanup()` (`await this.cdp.close()`, browser.js:433) before Chromium is SIGTERMed.
12. **Dead code / unused imports**: `getChromiumVersion` (browser.js:86-93) uses `require` in an ESM module → always returns `'unknown'` (empirically confirmed) and is never called; unused imports `ERRORS`/`formatMCPError` in cdp.js:3 and `formatMCPError` in browser.js:7.
13. **`isPrivateIP` not exported** despite ARCHITECTURE.md listing it as a key function; `172.` prefix over-blocks public 172.32+ addresses; hostnames like `10.example.com` over-blocked; IPv6 ULA (`fc00::`/`fd00::`) not blocked (all safe-direction, but the public-172.x false positive can break legit navigation).
14. **No `uncaughtException`/`unhandledRejection` guard in index.js** — Finding 1 is survivable with one.
15. **No dedicated console-buffer test file** (only indirect coverage in memory.test.js/reading-tools.test.js); no test exercises `_killChildrenByProfile` or the WS `'error'` path (which is why Findings 1-2 escaped).
16. **Not a git repository** — no history, cannot diff; note for ops.

### Recommendations

1. Fix the `'error'` crash (blocker) first: log-and-ignore or subscribe in browser.js.
2. Import `readdirSync` or delete `_killChildrenByProfile`.
3. Don't reset `restartAttempts` in `start()` (or track crash timestamps) so the restart circuit breaker works for success-loops.
4. Set `failureReason` in `start()`'s catch and skip `cleanup()`'s state overwrite, so start failures surface `CHROMIUM_RESTART_FAILED` + stderr.
5. Check `exitCode` before the 5s wait in cleanup.
6. Wire `MAX_IMAGE_BYTES` into the screenshot handler (or drop the docs/env claim), fix AGENTS.md tool count + ARCHITECTURE.md `detached` claim.
7. Add tests: WS `'error'` handling, orphan-child cleanup, consecutive-crash circuit breaker, malformed `IDLE_SHUTDOWN_MS`.

Residual risks: the Chromium-spawning integration tests (browser/integration/interaction/reading-tools/restart/reconnect/cleanup/idle-shutdown/lazy-start/parallel/memory) were **not run** (task forbids spawning Chromium); their passing is attested only by `markdown-files/` reports. The common crash/terminate paths empirically produce a clean `'close'` (survivable); the crash bug is confirmed on connect-failure paths and is a latent hazard on any socket-`'error'` path.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Findings cite exact file:line locations (e.g., cdp.js:47/85-88 unhandled 'error' crash, browser.js:395 missing readdirSync import, browser.js:150 restartAttempts reset, index.js:32 unvalidated IDLE_SHUTDOWN_MS) and severities (1 blocker, 6 medium, 9 low). Three findings were empirically reproduced via read-only node one-liners: CDPClient 'error' crash on refused connect; getChromiumVersion always returning 'unknown' (require in ESM); _killChildrenByProfile silently no-op."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "node --test tests/cdp.test.js tests/utils.test.js tests/lock.test.js tests/helpers.test.js",
      "result": "passed",
      "summary": "57/57 pure unit tests pass (no Chromium involved)"
    },
    {
      "command": "node repro: CDPClient.connect('ws://127.0.0.1:1/')",
      "result": "failed",
      "summary": "Process crashed with 'Unhandled error event' at cdp.js:87 — confirms blocker Finding 1"
    },
    {
      "command": "node repro: Browser.getChromiumVersion('/bin/true') and Browser._killChildrenByProfile('/tmp/nonexistent')",
      "result": "passed",
      "summary": "Confirmed dead code: getChromiumVersion returns 'unknown' (require undefined in ESM); _killChildrenByProfile silently no-ops (readdirSync not imported)"
    },
    {
      "command": "node repro: abrupt peer SIGKILL with in-flight CDP request (FIN and RST variants)",
      "result": "passed",
      "summary": "Both scenarios survived via 'WebSocket closed'/'write ECANCELED' — scopes the crash bug to socket-'error' emission paths (confirmed on connect-refused), not the common SIGKILL/terminate paths"
    }
  ],
  "validationOutput": [
    "57/57 unit tests pass; 0 failures",
    "Crash bug reproduced: uncaught 'Unhandled error event' thrown from cdp.js:87 (emit('error') with zero listeners) when WebSocket errors during connect",
    "readdirSync ReferenceError in _killChildrenByProfile silently swallowed (browser.js:395)",
    "getChromiumVersion always returns 'unknown' — require() is not defined in ESM",
    "8 tools registered in index.js vs AGENTS.md claim of 5; detached:false in code vs ARCHITECTURE.md claim of detached:true"
  ],
  "residualRisks": [
    "Chromium-spawning integration tests (browser/integration/interaction/reading-tools/restart/reconnect/cleanup/idle-shutdown/lazy-start/parallel/memory) not run per review constraints; passing attested only by markdown-files/ reports",
    "Blocker Finding 1 is latent on any future socket-error path (ECONNRESET during active traffic, TLS/DNS failures) even though SIGKILL/terminate paths currently produce clean 'close'",
    "Not a git repository: no history or diff capability for the codebase"
  ],
  "noStagedFiles": true,
  "diffSummary": "Read-only code-quality review; no files modified. plan.md/progress.md absent at repo root (plan lives in markdown-files/PLAN.md).",
  "reviewFindings": [
    "blocker: src/cdp.js:47,85-88 - CDPClient emits 'error' with no listener; Node throws 'Unhandled error event' and the whole server process crashes on any WebSocket error (empirically reproduced on refused connect). Fix: log-only or subscribe.",
    "medium: src/browser.js:395 - readdirSync used but never imported; _killChildrenByProfile silently never runs (ReferenceError swallowed), leaving orphan-Chromium cleanup mitigation dead (empirically confirmed no-op).",
    "medium: src/browser.js:150,342-354 - restartAttempts reset to 0 on every successful start(); crash-success loops restart indefinitely, defeating the documented 'max 2 restarts then FAILED' circuit breaker.",
    "medium: src/browser.js:154-155,489 - start() catch sets FAILED then cleanup() overwrites to STOPPED without setting failureReason; start failures never surface CHROMIUM_RESTART_FAILED+stderr and every later call silently retries.",
    "medium: src/browser.js:440-445 - cleanup() waits a fixed 5s for an exit event that already fired in the crash-restart path; every crash restart pays 5s. Check exitCode !== null first.",
    "medium: src/utils.js:131 - truncateBuffer/MAX_IMAGE_BYTES unused in production; screenshot handler never enforces the documented 10MB image cap (ARCHITECTURE.md, .env.example).",
    "medium: docs drift - AGENTS.md:24 says 5 tools (code has 8); ARCHITECTURE.md:101 claims detached:true/own process group (code uses detached:false, browser.js:121); ARCHITECTURE.md call graph and test-file list incomplete.",
    "low: index.js:32 - IDLE_SHUTDOWN_MS parseInt unvalidated; malformed value => NaN => setTimeout fires immediately (idle-shutdown loop).",
    "low: index.js:539 - browser_snapshot max_items has no .min; 0/negative yields truncated:true with 0 elements.",
    "low: index.js - inconsistent error formatting: get_text/screenshot/console/snapshot return bare err.message without [CODE] prefix vs formatToolError elsewhere.",
    "low: src/cdp.js close() - no terminate()/close timeout; hung peer hangs browser.cleanup() before SIGTERM to Chromium.",
    "low: dead code - getChromiumVersion (browser.js:86-93) uses require in ESM, always returns 'unknown', never called; unused imports ERRORS/formatMCPError in cdp.js:3 and formatMCPError in browser.js:7.",
    "low: src/utils.js:69-79 - isPrivateIP not exported; 172.x prefix over-blocks public 172.32+; IPv6 ULA not blocked; hostname prefixes over-blocked.",
    "low: index.js - no uncaughtException/unhandledRejection guard; Finding 1 is survivable with one.",
    "low: tests - no dedicated console-buffer test file; no test covers WS 'error' path or _killChildrenByProfile, which is why Findings 1-2 escaped.",
    "low: repo hygiene - not a git repository; no history/diff capability."
  ],
  "manualNotes": "plan.md/progress.md requested in the task do not exist at /root/browser-mcp (found in markdown-files/PLAN.md instead). Review was strictly read-only: no Chromium spawned, no files edited. All three empirical repro commands were temporary node -e one-liners with no filesystem or process side effects beyond a throwaway in-memory client. Everything in the codebase that is currently good (architecture layering, security model, lock, state-machine guards, idle-shutdown safety, test breadth) is corroborated with file:line evidence above."
}
```

────────────────────────────────────
↑626  ↓6.3k  ·  $0.0021  ·  󰅐 8m 25s