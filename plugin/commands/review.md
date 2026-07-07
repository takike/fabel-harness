---
description: Adversarial code review - parallel lens reviewers, skeptic verification of every finding, loop-until-dry
argument-hint: [base-ref or scope, default: working tree diff vs HEAD]
---

Run an adversarial fabel review.

**Scope**: $ARGUMENTS (if empty: uncommitted changes vs HEAD; if a ref: diff from that
ref; if a path: that file/directory).

First read the `fabel:doctrine` and `fabel:verification-protocol` skills. Then loop:

## Round structure (repeat until dry)

1. **Find** — spawn `reviewer` subagents IN PARALLEL, one per lens:
   `correctness`, `security`, `concurrency`, `tests` (add `api-misuse` for public API
   changes). Each gets the same scope and its single lens. Remind each: report
   everything, the skeptic filters.
2. **Dedupe** — normalize findings to the protocol schema and dedupe against ALL
   findings seen in ANY prior round (including refuted ones).
3. **Verify** — spawn one `skeptic` per NEW finding, in parallel. Collect verdicts.

**Termination**: stop when 2 consecutive rounds produce zero new findings surviving
as CONFIRMED, or after 4 rounds total. From round 2 onward, tell reviewers what was
already found so they hunt fresh territory.

## Report

Per the protocol: lead with counts ("N confirmed, M plausible, K refuted"), then
CONFIRMED findings ranked by severity with skeptic evidence, then PLAUSIBLE. Omit
refuted findings. If the round cap ended the loop while findings were still arriving,
say coverage may be incomplete. Do NOT fix anything unless the user asked for fixes —
the review report is the deliverable.
