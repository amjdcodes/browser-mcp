# Task for reviewer

[Read from: /root/browser-mcp/plan.md, /root/browser-mcp/progress.md]

Perform a thorough SECURITY VULNERABILITY review of the entire /root/browser-mcp codebase (an MCP server for headless Chromium automation via raw CDP, stdio transport). Review ALL source files: index.js, src/browser.js, src/cdp.js, src/console-buffer.js, src/helpers.js, src/lock.js, src/utils.js, and package.json (dependency check). Focus on: (1) URL validation bypasses in src/utils.js (does it actually reject file:, javascript:, data:, blob:, about: schemes and private IPs in every path, including redirects, hostname edge cases like 0x7f000001, decimal/octal IPs, trailing dots, userinfo, IDN/punycode, IPv6 forms)? (2) path traversal in screenshot output handling (helpers.js / index.js) — can a crafted title/filename escape OUTPUT_DIR? (3) injection risks: CDP command injection, command-line argument injection into the Chromium spawn (src/browser.js), prototype pollution, log injection, (4) SSRF risks: does the page get navigated to attacker-controlled URLs, what can a malicious page reach via CDP (e.g. FileSystem, network)? (5) secrets handling: .env.example, credentials, debug endpoints exposure, (6) resource exhaustion: unbounded console buffer, screenshot size, huge pages, process limits, (7) race conditions with security impact, (8) unvalidated input from MCP tool callers (browser_navigate, browser_get_text, browser_screenshot, browser_get_console, browser_snapshot) — can a caller crash or compromise the server process? For each finding, rate severity (critical/high/medium/low/info), give file:line evidence, and propose a concrete mitigation. Verify every claim from the code — do not invent issues. Do NOT make any edits. Return a structured security report.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```