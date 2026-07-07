---
description: Evidence-based end-to-end verification of the current changes; writes .fabel/verified on PASS
argument-hint: [test command override]
---

Run standalone fabel verification of the current changes.

**Command override (optional)**: $ARGUMENTS

First read the `fabel:doctrine` skill (rule 5). Then:

1. Determine the scope: `git diff HEAD` (plus untracked files) — what actually changed.
2. Identify the runtime surface of those changes: the command/endpoint/flow a user
   hits to reach the changed code. If the diff has no runtime surface (docs only),
   report that and stop.
3. Spawn the `verifier` subagent with: the diff summary, the runtime surface, and the
   test command ($ARGUMENTS if given, otherwise let the verifier detect from
   package.json / Makefile / pyproject.toml).
4. Relay the verifier's verdict VERBATIM in spirit: quote its evidence, keep its
   PASS/FAIL/PARTIAL. Do not upgrade a PARTIAL to a PASS.
5. On PASS only: `mkdir -p .fabel && git diff HEAD | git hash-object --stdin > .fabel/verified`
   (records the verified tree state for the opt-in commit gate). On FAIL/PARTIAL, do
   not write the marker; report what failed or remains unverified instead.
