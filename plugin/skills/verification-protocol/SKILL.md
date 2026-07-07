---
name: verification-protocol
description: The finding lifecycle for adversarial review - finding schema, dedupe rules, skeptic attack procedure, verdict semantics, and how to rank/report results. Read when running /fabel:review, verifying reviewer findings, or aggregating verdicts from skeptic agents.
---

# Verification protocol

How raw findings become trustworthy reports. Used by /fabel:review and the
self-review stage of /fabel:solve.

## Finding schema

Every finding, from any reviewer lens, is normalized to:

- `summary` — one sentence stating the defect.
- `file`, `line` — anchor in the new/changed code.
- `failure_scenario` — concrete inputs/state → wrong output/crash. Mandatory; a
  finding without a scenario is sent back or dropped.
- `severity` — critical | major | minor (reviewer's estimate).
- `confidence` — high | medium | low (reviewer's estimate; used for verification
  priority, never for silent discarding).
- `lens` — which reviewer produced it.

## Dedupe rules

Before verification, dedupe new findings against ALL previously seen findings
(including REFUTED ones — otherwise dead findings resurrect every round):
- Same `file` and overlapping line range (±3) and same root cause → duplicate; keep
  the higher-severity phrasing.
- Same root cause reported from different lenses → one finding, note both lenses.

## Skeptic attack

One skeptic subagent per finding, in parallel. The skeptic receives the normalized
finding plus the diff scope, and returns:

- `REFUTED` — a cited guard/invariant makes the scenario impossible. The finding dies.
  It stays in the seen-set for dedupe but never reappears in reports.
- `CONFIRMED` — traced path or executed repro proves it. Eligible for fixing/reporting.
- `PLAUSIBLE` — neither refuted nor proven. Reported below CONFIRMED, marked as such.

A skeptic verdict of CONFIRMED without a `file:line` chain or repro output is
malformed — treat as PLAUSIBLE.

## Termination (loop-until-dry)

Rounds of (reviewers → dedupe → skeptics) continue until 2 consecutive rounds add
zero NEW findings that survive as CONFIRMED — counting against the full seen-set,
not just confirmed ones. Hard cap: 4 rounds. On hitting the cap with the last round
still producing new confirmations, say so in the report ("coverage may be incomplete").

## Report format

Ranked: CONFIRMED (by severity) first, then PLAUSIBLE (by severity). REFUTED findings
are omitted (optionally one line: "N findings refuted during verification").
Each reported finding shows: severity, `file:line`, summary, failure scenario, and
the skeptic's evidence. Lead with the count: "3 confirmed, 2 plausible, 9 refuted."
