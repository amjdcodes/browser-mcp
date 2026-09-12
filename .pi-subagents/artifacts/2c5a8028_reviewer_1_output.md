All evidence is gathered and verified. Here is the structured security report.

## Review — Security Vulnerability Report: browser-mcp

**Method:** read all source files (index.js, src/browser.js, src/cdp.js, src/console-buffer.js, src/helpers.js, src/lock.js, src/utils.js, package.json, .env.example, README), ran live Node probes against `validateURL` (Node v26.2.0), ran live headless-Chromium navigation probes (chromium at /usr/bin/chromium), and cross-checked tests/docs. All findings below are empirically or statically verified; nothing is invented.

### Findings

**HIGH — SSRF to link-local / cloud metadata (169.254.169.254) not blocked**
- Evidence: `validateURL('http://169.254.169.254/')` returns `valid: true` (live probe). `isPrivateIP` (src/utils.js:69-77) only prefix-matches `10.`, `192.168.`, `172.` and `*.local`/`*.internal`; `169.254.0.0/16` (AWS/GCP/Azure metadata, including IAM credential endpoints) is not covered. `ALLOWED_HOSTS` (src/utils.js:5) doesn't include it either. README.md:189 claims "Private IP ranges blocked by default".
- Impact: a browser-navigate → get-text/screenshot round trip exfiltrates cloud instance metadata incl. IAM temporary credentials on common cloud deployments.
- Mitigation: parse the hostname to an IP (resolve A/AAAA and reject when *any* resolved address is in a deny list) or use the WHATWG/`ipaddr.js`-style range check covering 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 198.18/15, 224/4, 240/4, `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped `::ffff:` forms; also verify post-resolution (see finding 3).

**HIGH — SSRF via IPv4-mapped IPv6 (`[::ffff:X]`) and all IPv6 forms**
- Evidence: `validateURL('http://[::ffff:10.0.0.1]/')` → valid (hostname `[::ffff:a00:1]`, no prefix match); `[::ffff:169.254.169.254]` → valid; `[::1]` → valid. `isPrivateIP` has zero IPv6 handling, and `ALLOWED_HOSTS` entry `'::1'` (src/utils.js:5) can *never* match because Node normalizes IPv6 hostnames with brackets (`new URL('http://[::1]/').hostname === '[::1]'`) — the IPv6 behavior is entirely accidental.
- Empirical proof the mapped form reaches IPv4 targets: headless Chromium navigating to `http://[::ffff:127.0.0.1]:48123/` successfully connected to a server bound on 127.0.0.1 (server log: `SERVER_GOT_REQUEST [::ffff:7f00:1]:48123 /`).
- Mitigation: reject `::ffff:`/`::ffff:0:` mapped ranges before the prefix checks; treat IPv6 hostnames without brackets before allowlist matching.

**HIGH — Redirect-based SSRF: final URL never re-validated**
- Evidence: index.js:211 issues `Page.navigate` with the validated URL; Chromium follows 301/302/307/308 chains; `finalUrl` is captured from `Page.frameNavigated` (index.js:196) but only reported — never re-checked. `MAX_REDIRECTS` is documented as "RESERVED (not yet implemented)" in .env.example.
- Impact: any attacker-controlled public URL that redirects to `169.254.169.254`/private IP defeats the entire URL gate, even if findings 1–2 were fixed.
- Mitigation: subscribe to `Network.requestWillBeSent` and abort (`Network.setBlockedURLs`, or `Fetch.requestPaused`/`Fetch.fulfillRequest` abort) any request whose resolved host/IP is disallowed; or verify `finalUrl` post-navigation and hard-fail.

**MEDIUM — Remaining SSRF gaps and over-blocking in the documented block list**
- Evidence (all `valid: true` via live probe): `0.0.0.0`, `0` (→ `0.0.0.0`), `127.0.0.2` (and any `127/8` beyond `.1`), `100.64.0.1` (CGNAT), `198.18.0.1` (benchmark/used by some internal infra), `240.0.0.1` (reserved), `[::ffff:0:0]`, `localhost.` (trailing dot). Conversely, `'172.'` prefix (src/utils.js:73) over-blocks public `172.0.0.0–172.15.255.255` (availability false positive).
- Note: `127.0.0.2`/`0.0.0.0` only reach wildcard-bound local services; still inconsistent with the documented posture. Mitigation as finding 1.

**MEDIUM — Unbounded per-message console buffer (memory/response DoS)**
- Evidence: src/browser.js:257,269 push page-controlled `text` into `consoleBuffer`; src/console-buffer.js caps *count* (500, `MAX_CONSOLE_MESSAGES`) but never *bytes* per message. A page can `console.log('A'.repeat(50e6))`; `browser_get_console` then JSON-stringifies multi-MB strings over stdio (index.js:519-522). `truncateConsole` (utils.js:160-170) only trims line count.
- Mitigation: cap per-message text length (e.g., `MAX_CONSOLE_LINE_LENGTH`) at `add()` time, and/or cap total buffer bytes.

**MEDIUM — Screenshot payloads not size-capped (dead `MAX_IMAGE_BYTES`)**
- Evidence: `truncateBuffer`/`MAX_IMAGE_BYTES` (src/utils.js:131, 10 MB default) has zero call sites in src/index.js (grep-verified; only tests reference it). index.js:451-453 converts the full CDP base64 to a Buffer, writes it, and returns the *full* base64 in the tool result (`data: result.data`, index.js:457-460). Only the pixel count is capped (16 MP, index.js:431-437) — a 16 MP JPEG at quality 80 can be tens of MB per response.
- Mitigation: enforce `truncateBuffer` (or reject) on `result.data` before returning; keep writing the full file but return only the path/truncated thumbnail.

**LOW — Credentials in URL userinfo logged to stderr**
- Evidence: index.js:182 `[MCP] Navigating to: ${url}` logs the raw, unredacted URL (userinfo preserved by `new URL(...).href`). A URL like `http://user:pass@host/` leaks the password into stderr logs. (Contrast: browser_type deliberately never logs `text`, index.js:769.)
- Mitigation: strip `username`/`password` before logging.

**LOW — Log injection via dialog messages**
- Evidence: src/browser.js:345-346 logs `params.message` (page-controlled alert/confirm/prompt text) raw to stderr — arbitrary newlines/control characters enable log spoofing.
- Mitigation: sanitize/JSON-encode the message before logging.

**LOW — Unescaped attribute values in snapshot-generated CSS selectors (functional, not code injection)**
- Evidence: index.js:316-345 interpolates `attrObj.id`/`name`/`aria-label`/`placeholder`/`value` into selector strings without CSS-escaping; an element with `id='a"b'` yields invalid CSS. Downstream use is safe (helpers.js passes selectors as CDP *data arguments* via `callFunctionOn`; index.js:129,377 use `JSON.stringify`), so this is at most a DoS of the individual tool call, not code injection.
- Mitigation: escape selector metacharacters or use `CSS.escape`.

**INFO — `readdirSync` never imported (dead code)**
- Evidence: src/browser.js:395 uses `readdirSync('/proc')` but the import (src/browser.js:2) omits it → `_killChildrenByProfile` always throws, is caught, and silently does nothing. Orphaned Chromium children are not killed (profile-dir recreation race persists).
- Mitigation: add `readdirSync` to the `node:fs` import.

**INFO — `getChromiumVersion` is dead code with two hazards**
- Evidence: src/browser.js:86-91 — zero call sites (grep-verified); uses `require()` in an ESM module (would always throw ReferenceError) and `execSync(\`${execPath} --version\`)` (shell-interpolated `CHROMIUM_PATH` → command-injection-shaped if ever wired up). `spawn(execPath, args)` at src/browser.js:158 is shell-free and safe.
- Mitigation: delete the method; if ever needed, use `spawnSync(execPath, ['--version'])` with the file-array form.

**INFO — `validateSafePath` is sound for remote attackers; latent prefix bug**
- Evidence: src/utils.js:84-106 — absolute paths and any `..` are rejected before `resolve()`, so lexical escape is impossible; the `resolved.startsWith(resolvedOutputDir)` prefix check (utils.js:99) is a latent bug only if the `'..'` guard is ever relaxed, and symlinks inside OUTPUT_DIR (local attacker) could redirect writes. Not reachable remotely — no finding above LOW. Screenshot path traversal: **no exploitable bypass found**.

**INFO — Test coverage gap**
- Evidence: tests/utils.test.js:71-75 tests only `192.168.1.1`; zero coverage of `169.254.169.254`, IPv4-mapped IPv6, numeric/hex/octal IPs, trailing dots, `0.0.0.0`, or redirect chains. Every bypass in findings 1–4 passes the existing suite.

### What is correct (verified good)
- **Injection-proof interaction layer**: helpers.js passes all selectors/text via `Runtime.callFunctionOn` `arguments` (data values), never concatenated; static helper strings only. Verified.
- **Scheme gate**: `file:`/`javascript:`/`data:`/`vbscript:` rejected, scheme lowercased (src/utils.js:6,46); unknown schemes rejected.
- **Numeric IP normalization works**: Node's WHATWG parser maps decimal/hex/octal IPv4 to dotted quad — `2130706433`, `0x7f000001`, `0177.0.0.1` → `127.0.0.1` (allowed by design); `0x0A000001` → `10.0.0.1` (blocked). Live-verified.
- **Chromium hardening**: `--remote-debugging-address=127.0.0.1`, random port, loopback-only CDP fetch; `spawn` without shell.
- **Resource controls that work**: `capTimeout` (100…MAX_TIMEOUT_MS), pixel cap on screenshots, snapshot item cap (200), queue cap (8) with watchdog, idle shutdown, console cleared on main-frame navigation.
- **No prototype pollution path found**: CDP params consumed via property reads; the snapshot `attrObj['__proto__']` assignment would receive a string primitive → no-op per spec.
- **No secrets committed**: only `.env.example` (documentation, no values). `browser_type` never logs typed text.

### Residual risks (not fully verifiable here)
- DNS rebinding: validation is string-based; Chromium resolves at fetch time — inherent without post-resolution checks (mitigation in finding 1/3).
- IDN/circled-digit mapping divergence: Node maps `①.②.③.④` → `1.2.3.4` and `⑩.⓿.⓿.⓿` → `10.xn--7vh…` (blocked only by the accidental `10.` prefix). Chromium probes for unroutable hosts aborted in this container, so a Node/Chromium IDNA divergence yielding a private IP could not be fully ruled out. Fixing findings 1–2 via IP-range checks covers this class.
- Local same-host trust: tmpdir profile, `/proc` scan, env vars — assume the operator controls the host.

Read-only review; no files were modified.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Returned concrete findings with file:line evidence and severity ratings for all claimed vulnerabilities. Empirical verification: live Node probe of validateURL showed 169.254.169.254, [::ffff:10.0.0.1], [::ffff:169.254.169.254], 0.0.0.0, 127.0.0.2, 0x0A000001-normalized, localhost. all accepted or correctly handled as described; live Chromium probe proved [::ffff:127.0.0.1] reaches IPv4 loopback services; code inspection proved redirects are never re-validated (index.js:196,211) and truncateBuffer/MAX_IMAGE_BYTES is dead code (no call sites). All findings cited as severity + file:line."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "node -e validateURL probe (23 bypass/edge URLs)",
      "result": "passed",
      "summary": "Confirmed 169.254.169.254, [::ffff:10.0.0.1], [::ffff:169.254.169.254], 0.0.0.0, 127.0.0.2, 100.64.0.1, 198.18.0.1, 240.0.0.1, [::1], localhost. pass validation; decimal/hex/octal forms normalize to dotted quad (0x0A000001 blocked)"
    },
    {
      "command": "chromium --headless --dump-dom probes (IPv4-mapped, 127.0.0.2, 0.0.0.0, circled digits, trailing dot)",
      "result": "failed",
      "summary": "IPv4-mapped probe succeeded (server received request from [::ffff:7f00:1]) proving mapped-address reachability; unroutable/circled-digit probes aborted in container, so IDN divergence could not be fully tested (noted as residual risk)"
    },
    {
      "command": "grep-based static verification (truncateBuffer call sites, getChromiumVersion calls, readdirSync import, ALLOWED_HOSTS match, secrets scan, test coverage)",
      "result": "passed",
      "summary": "Confirmed dead code (truncateBuffer, getChromiumVersion, _killChildrenByProfile via missing readdirSync import), never-matching '::1' allowlist entry, no secrets, and absent SSRF-bypass test coverage"
    }
  ],
  "validationOutput": [
    "HIGH: SSRF via 169.254.169.254 link-local metadata not blocked (src/utils.js:69-77, validateURL at 41-64)",
    "HIGH: SSRF via IPv4-mapped IPv6 [::ffff:X] and all IPv6 (src/utils.js:69-77; empirically proven reachability)",
    "HIGH: Redirect-based SSRF, finalUrl never re-validated (index.js:196,211; MAX_REDIRECTS not implemented)",
    "MEDIUM: unblocked 0.0.0.0/127.0.0.2/100.64/10/198.18/15/240/4; over-blocked public 172.0-15",
    "MEDIUM: unbounded per-message console buffer (src/browser.js:257,269; src/console-buffer.js count-only cap)",
    "MEDIUM: screenshot base64 response uncapped, MAX_IMAGE_BYTES/truncateBuffer dead (index.js:451-460; src/utils.js:131)",
    "LOW: URL userinfo credentials logged to stderr (index.js:182)",
    "LOW: dialog message log injection (src/browser.js:345-346)",
    "LOW: unescaped attribute values in snapshot selectors, functional only (index.js:316-345)",
    "INFO: readdirSync not imported (src/browser.js:395); getChromiumVersion dead ESM-require/execSync code (src/browser.js:86-91); '::1' allowlist entry never matches; validateSafePath startsWith latent prefix bug (src/utils.js:99); test gap (tests/utils.test.js:71-75)",
    "NO exploitable path traversal, NO CDP command injection, NO spawn argument injection, NO prototype pollution, NO secret leakage found (verified)"
  ],
  "residualRisks": [
    "DNS rebinding: URL validation is string-based; Chromium resolves at fetch time — needs post-resolution IP re-validation",
    "Node vs Chromium IDNA/circled-digit mapping divergence could not be fully excluded (Chromium aborted on unroutable hosts in this container); IP-range validation per finding 1-2 covers the class",
    "Localhost (127.0.0.1) reachable by design; wildcard-bound local services also reachable via 127.0.0.2/0.0.0.0 — acceptable only if localhost trust is intended",
    "Local same-host trust (tmpdir profile dir, /proc scan, operator-controlled env vars) assumes a non-hostile host operator"
  ],
  "noStagedFiles": true,
  "diffSummary": "Read-only security review; no files changed",
  "reviewFindings": [
    "high: src/utils.js:69-77 - SSRF to 169.254.169.254 link-local/cloud metadata not blocked (validated live)",
    "high: src/utils.js:69-77 - IPv4-mapped IPv6 [::ffff:X] private/metadata addresses not blocked; Chromium reachability empirically proven",
    "high: index.js:196,211 - redirect chains never re-validated (finalUrl reported, not checked); MAX_REDIRECTS unimplemented",
    "medium: src/utils.js:73 - block list misses 0.0.0.0/8, 127/8 (non-.1), 100.64/10, 169.254/16, 198.18/15, 240/4; over-blocks public 172.0-15",
    "medium: src/browser.js:257,269 + src/console-buffer.js - console messages capped by count (500) not bytes; multi-MB JSON responses possible",
    "medium: index.js:451-460 - screenshot base64 returned uncapped; truncateBuffer/MAX_IMAGE_BYTES (src/utils.js:131) dead code",
    "low: index.js:182 - raw URL (incl. userinfo credentials) logged to stderr",
    "low: src/browser.js:345-346 - page-controlled dialog text logged raw (log spoofing)",
    "low: index.js:316-345 - snapshot CSS selectors built from unescaped DOM attribute values (functional only)",
    "info: src/browser.js:395 - readdirSync not imported; _killChildrenByProfile dead code",
    "info: src/browser.js:86-91 - getChromiumVersion dead code: ESM require() + shell-interpolated execSync",
    "info: src/utils.js:5 - '::1' allowlist entry never matches bracketed IPv6 hostnames",
    "info: tests/utils.test.js:71-75 - no coverage of any SSRF bypass form",
    "no blockers found in: path traversal (validateSafePath), CDP/spawn injection, prototype pollution, secrets handling"
  ],
  "manualNotes": "No plan.md/progress.md present at /root/browser-mcp (ENOENT) despite task reference; review proceeded from source. All claims empirically or statically verified. Report is read-only; no edits made."
}
```

────────────────────────────────────
↑424  ↓6.5k  ·  $0.0021  ·  󰅐 6m 43s