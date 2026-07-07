---
description: Full Fable-class solve pipeline - explore, plan (skeptic-attacked), implement, verify-fix loop, adversarial self-review
argument-hint: <task description> [auto]
---

Run the full fabel solve pipeline on this task:

**Task**: $ARGUMENTS

First read the `fabel:doctrine` skill and follow it throughout. Then execute these
stages in order — do not skip or reorder:

## 1. Explore
Spawn 2-4 `explorer` subagents IN PARALLEL (single message), each with a distinct
slice: (a) the modules the task touches, (b) the test layout for those modules,
(c) codebase conventions and reusable utilities, (d) similar prior features if any.
Work only from their digests; do not re-dump files they already mapped.

## 2. Plan
Spawn `planner` with the task plus the explorer digests. Then spawn ONE `skeptic`
against the plan: "what breaks if we implement exactly this?" Revise the plan for any
CONFIRMED objection. If the task argument does not include `auto`, present the revised
plan to the user and wait for approval before implementing; with `auto`, proceed.

## 3. Implement
Implement in THIS thread (not a subagent), following the plan step by step, so the
user sees the changes and permission flow. Match surrounding code conventions the
explorers identified. If the plan proves wrong mid-flight, revise it explicitly.

## 4. Verify (loop)
Spawn `verifier` with the diff scope and the project's test commands. On FAIL: fix in
this thread, re-spawn verifier. Maximum 3 rounds; if still failing, stop and report
the honest state with the failing output.

## 5. Self-review
Spawn `reviewer` (lens: correctness) on `git diff` of the work. Send EVERY finding to
a `skeptic` (one each, in parallel), per the `fabel:verification-protocol` skill. Fix
CONFIRMED findings, then re-run stage 4 once. Report PLAUSIBLE findings honestly.

## 6. Report
Lead with the outcome: what works now, verified how (quote verifier evidence). Then:
what was fixed in self-review, anything PLAUSIBLE left open, anything unverified.
