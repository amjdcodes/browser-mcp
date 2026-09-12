# Task for reviewer

[Read from: /root/browser-mcp/plan.md, /root/browser-mcp/progress.md]

Find UNUSED CODE in the browser-mcp project at /root/browser-mcp (an MCP server for headless Chromium automation via raw CDP, ESM Node.js). Read AGENTS.md, index.js, src/browser.js, src/cdp.js, src/console-buffer.js, src/utils.js, tests/*.test.js, and python-files/ (manual integration scripts). Hunt for: (1) exported functions/constants never imported or called anywhere (use grep to verify each export's usages); (2) unused imports; (3) dead or unreachable code paths (e.g., code after return, impossible conditions); (4) unused function parameters; (5) unused helper functions in src/utils.js; (6) unused test files, fixtures, or scripts; (7) duplicate implementations that make one version dead. For each finding: give file:line, the item, your verification method (e.g., 'grep of identifier X found only its definition'), and a recommendation (remove / keep, with justification, being careful not to flag items used only in tests or used dynamically). Produce a final summary table grouped by confidence (certain / likely / needs human decision). Do NOT modify any files — read-only review.

---
**Output:**
Write your findings to exactly this path: /root/browser-mcp/.pi-subagents/artifacts/outputs/3c6f1dd5/reports/unused.md
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