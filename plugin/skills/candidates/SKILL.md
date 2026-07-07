---
name: candidates
description: Recipe for multi-candidate implementation - generate N independent solutions in parallel git worktrees from differentiated angles, judge them on a panel, merge the winner, clean up. Use when the solution space is wide (multiple credible designs), the change is high-stakes, or the user asks for "best of N" / candidates.
---

# Multi-candidate implementation

One attempt iterated is weaker than N independent attempts judged, when the solution
space is wide. This is the expensive mode — use it deliberately, not by default.

## When to use

- Multiple credible designs exist and picking wrong is costly to unwind.
- The user asked for alternatives / best-of-N.
- A previous single attempt produced a working-but-unsatisfying result.

Skip it for mechanical changes with one obvious shape.

## Procedure

1. **Shared exploration** — explore ONCE (explorer fan-out), produce one digest all
   candidates build on. Candidates differ in approach, not in facts.
2. **Worktrees** — from a clean base ref, create one worktree per candidate:
   `git worktree add .fabel/worktrees/<run>/cand-<i> -b fabel/cand-<i> <base>`.
   Refuse to start if the main tree is dirty (stash or commit first).
3. **Differentiated angles** — each candidate gets the SAME task + digest but a
   different stance, e.g.: minimal-change (smallest diff that solves it),
   refactor-first (restructure so the fix is natural), test-first (write the failing
   tests, then satisfy them). Identical prompts produce redundant candidates — the
   diversity IS the value.
4. **Independent implementation** — implement each candidate in its own worktree with
   no knowledge of the others. Run the project's tests inside each worktree.
5. **Judge panel** — collect each candidate's diff (`git -C <wt> diff <base>`).
   Anonymize as A/B/C, shuffle order per judge, spawn an ODD number of judges (3+)
   in parallel, one score-set per candidate per judge. Aggregate by median rank per
   candidate; break ties with an extra judge, not by re-scoring yourself.
6. **Merge the winner** — apply the winning branch onto the base (merge or
   cherry-pick), re-run verification in the main tree. Optionally graft clearly
   superior pieces from runners-up ONLY if the judges' justifications named them.
7. **Cleanup** — `git worktree remove` all candidate worktrees and delete
   `fabel/cand-*` branches. Keep them only if the user wants to inspect losers.

## Judge hygiene

- Judges never learn which model/agent/stance produced a candidate.
- Labels and orderings are meaningless — state this in the judge prompt.
- The orchestrator (you) aggregates scores mechanically; you do not override the
  panel because you "like" a loser. If you believe the panel erred, run one more
  judge with the specific concern spelled out, and let the aggregate decide.
