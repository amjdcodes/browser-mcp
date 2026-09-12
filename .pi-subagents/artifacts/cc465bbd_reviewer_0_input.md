# Task for reviewer

[Read from: /root/browser-mcp/plan.md, /root/browser-mcp/progress.md]

Perform a thorough CODE QUALITY review of the entire /root/browser-mcp codebase (an MCP server for headless Chromium automation via raw CDP). Review ALL source files: index.js, src/browser.js, src/cdp.js, src/console-buffer.js, src/helpers.js, src/lock.js, src/utils.js. Also skim the test files in tests/ to assess coverage. Focus on: (1) architecture drift or tech debt vs the architecture described in AGENTS.md and ARCHITECTURE.md, (2) inconsistent patterns or naming, (3) error handling gaps (unhandled rejections, missing timeouts, resource leaks like unclosed WebSocket connections or child processes), (4) race conditions or fragile concurrency code (lazy browser start, auto-restart, idle shutdown, lock.js), (5) areas lacking tests or documentation, (6) obvious bugs or dead code, (7) opportunities to simplify or consolidate. Verify claims from the code with file paths and line numbers. Do NOT run the server or spawn Chromium — read-only inspection plus `node --test` if you need to confirm test status is acceptable. Do NOT make any edits. Return a structured report: what is good (with evidence), issues found (location + severity), and recommendations.

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