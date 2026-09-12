# Task for reviewer

[Read from: /root/browser-mcp/plan.md, /root/browser-mcp/progress.md]

Perform a thorough CODE QUALITY review of the /root/browser-mcp codebase (MCP server for headless Chromium automation via raw CDP). Review all source files: index.js, src/browser.js, src/cdp.js, src/console-buffer.js, src/helpers.js, src/lock.js, src/utils.js, plus a skim of tests/ for coverage. Focus on: architecture drift vs AGENTS.md/ARCHITECTURE.md, inconsistent patterns/naming, error handling gaps (unhandled rejections, missing timeouts, resource leaks like unclosed WebSocket connections or child processes), race conditions / fragile concurrency (lazy start, auto-restart, idle shutdown, lock.js), missing tests or docs, obvious bugs or dead code, simplification opportunities. Verify claims from code with file:line evidence. Read-only inspection only — do NOT spawn Chromium or edit anything. Return a structured report: what is good (with evidence), issues found (location + severity), recommendations.

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