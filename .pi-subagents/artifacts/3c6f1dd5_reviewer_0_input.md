# Task for reviewer

[Read from: /root/browser-mcp/plan.md, /root/browser-mcp/progress.md]

Perform a thorough CODE QUALITY review of the browser-mcp project at /root/browser-mcp (an MCP server for headless Chromium automation via raw CDP, ESM Node.js). Read AGENTS.md first for project conventions, then all source files (index.js, src/browser.js, src/cdp.js, src/console-buffer.js, src/utils.js), the tests (tests/*.test.js, fixtures/test-page.html), and package.json. Evaluate: (1) Clean Code principles — naming, readability, function size, single responsibility; (2) SOLID/DRY/KISS/YAGNI; (3) error handling — promise rejection handling, error propagation, crash-safety of the browser auto-restart logic; (4) resource management — WebSocket/child-process cleanup, timers, idle-shutdown; (5) concurrency and race conditions (lazy browser startup, request/response correlation by ID); (6) test quality and coverage of the stated behaviors in AGENTS.md. Produce a structured report: overall assessment, strengths, issues grouped by severity (critical/major/minor) with exact file:line references, and concrete prioritized recommendations. Do NOT modify any files — read-only review.

---
**Output:**
Write your findings to exactly this path: /root/browser-mcp/.pi-subagents/artifacts/outputs/3c6f1dd5/reports/quality.md
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