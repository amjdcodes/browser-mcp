# Workflow

- Prefers analysis/evaluation deliverables written to separate files adjacent to the source document (e.g., PLAN.REVIEW.md, PLAN.OPINION.md next to PLAN.md) rather than inline in chat. Confidence: 0.9
- Iterative planning workflow: read a source document, produce a separate review/opinion file, then update the source document based on that review. Confidence: 0.8
- When reviewing plans or documents, wants gaps and weaknesses explicitly identified and evaluated. Confidence: 0.8
- Respects strict scope boundaries: only modify or move files explicitly mentioned; do not touch unspecified files. Confidence: 0.8
- Prefers a read-only reconnaissance phase first: asks the agent to explore and explain/understand a project without editing any code (explicitly "just understand it"), then proceeds to the next step together. Confidence: 0.6
- Organizes project files into folders by naming convention (e.g., filename prefix, file extension). Confidence: 0.6
- Wants documentation kept in sync with the actual codebase: after new features/scripts are added, expects all relevant docs to be updated (e.g., README.md and AGENTS.md together), based on the code rather than the docs' existing claims. Confidence: 0.75
- Strongly non-destructive: explicitly warns against breaking/corrupting the project ("don't wreck the project"), expecting new work to add files without editing existing code or touching system configuration, and changes to be validated (e.g., run the test suite) before being declared done. Confidence: 0.75
- Prefers the real, evidence-backed way something was set up (e.g., the actual install command dug out of system logs/package history) to be confirmed as genuinely working before it is codified into a reusable, idempotent automation script added to the repo. Confidence: 0.65
- Before authorizing a potentially risky change, asks for a read-only feasibility/risk analysis (code untouched, "just analyze and write the report") weighing whether it will work or cause a fatal problem, then decides. Confidence: 0.75
