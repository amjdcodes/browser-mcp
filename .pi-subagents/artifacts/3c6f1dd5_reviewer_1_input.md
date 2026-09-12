# Task for reviewer

[Read from: /root/browser-mcp/plan.md, /root/browser-mcp/progress.md]

Perform a SECURITY VULNERABILITY audit of the browser-mcp project at /root/browser-mcp (an MCP server for headless Chromium automation via raw CDP, ESM Node.js). Read AGENTS.md, then all source files (index.js, src/browser.js, src/cdp.js, src/console-buffer.js, src/utils.js) and tests. Attack-surface focus: (1) URL validation in src/utils.js — bypasses of the file:/javascript:/data: rejection, private-IP blocking (IPv4/IPv6 edge cases, CIDR correctness, DNS rebinding, redirects to internal hosts, localhost variants like 127.1, 0x7f000001, [::1]); (2) path traversal in screenshot output paths and OUTPUT_DIR handling; (3) command injection or argument smuggling in Chromium spawn (args vs shell, env, --remote-debugging-port handling); (4) unsafe deserialization / injection through the MCP tool input schema; (5) WebSocket CDP channel trust boundaries and message handling; (6) SSRF risks given headless navigation; (7) secrets or debug data leakage to stdout/stderr or MCP responses. For each finding give: severity (critical/high/medium/low), attack scenario, file:line evidence, and a concrete fix. Explicitly call out which mitigations in AGENTS.md are correctly implemented vs missing. Do NOT modify any files — read-only review.

---
**Output:**
Write your findings to exactly this path: /root/browser-mcp/.pi-subagents/artifacts/outputs/3c6f1dd5/reports/security.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

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