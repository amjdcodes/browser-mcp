# Task for reviewer

[Read from: /root/browser-mcp/plan.md, /root/browser-mcp/progress.md]

Perform a thorough SECURITY VULNERABILITY review of the /root/browser-mcp codebase (MCP server for headless Chromium automation via raw CDP, stdio transport). Review all source files: index.js, src/browser.js, src/cdp.js, src/console-buffer.js, src/helpers.js, src/lock.js, src/utils.js, package.json. Focus on: URL validation bypasses in src/utils.js (file:/javascript:/data:/blob:/about: rejection, private IP blocking incl. decimal/octal/hex IPs, trailing dots, userinfo, IDN, IPv6 forms, redirects), path traversal in screenshot output, injection risks (CDP command injection, spawn argument injection in browser.js, prototype pollution, log injection), SSRF reach, secrets handling (.env.example), resource exhaustion (unbounded console buffer, huge screenshots/pages), race conditions with security impact, unvalidated MCP tool input that could crash or compromise the server. Rate each finding critical/high/medium/low/info with file:line evidence and concrete mitigation. Verify every claim — do not invent issues. Read-only — do NOT edit anything. Return a structured security report.

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