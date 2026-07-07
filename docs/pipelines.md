# Pipelines

Stage diagrams for the CLI pipelines (the plugin commands follow the same shapes,
orchestrated by the model instead of TypeScript).

## fabel solve

```
explore ──┬─ explorer(modules)     ─┐
          ├─ explorer(tests)        ├─→ digest
          └─ explorer(conventions) ─┘
plan ───── planner(digest) ─→ skeptic("what breaks?")
             │  CONFIRMED objection → planner revises once
             ▼
[--plan-only? stop here]
implement ─ single session (acceptEdits, resumable)
          │ or --candidates N:
          │   clean-tree gate → N worktrees from SHA-pinned base
          │   → N sessions with differentiated stances
          │     (minimal-change / refactor-first / test-first / defensive)
          │   → CLI commits each → per-candidate verify
          │   → judge panel (anonymized labels, fresh order per seat,
          │     median rank, tie → extra seat → mean total)
          │   → squash-merge winner (staged, uncommitted) → cleanup
          ▼
verify ─── deterministic commands (config > --cmd > auto-detect)
          │ FAIL → resume implement session with failure output → re-verify
          │ (up to --max-rounds, default 3)
          ▼
self-review ─ reviewer(correctness) on the diff
          │   → one skeptic per finding
          │   → CONFIRMED → fix (resumed session) → re-verify once
          ▼
report ─── outcome first; evidence; PLAUSIBLE leftovers; honest notes
```

## fabel review

```
round r:  reviewer(lens₁) ∥ reviewer(lens₂) ∥ ...   (full recall, no filtering)
            → normalize → dedupe vs ALL prior findings (incl. refuted)
            → one skeptic per fresh finding (parallel)
            → CONFIRMED/REFUTED/PLAUSIBLE
repeat until: 2 consecutive rounds add zero new CONFIRMED (or 4 rounds, or budget)
report: counts first; CONFIRMED by severity with skeptic evidence; PLAUSIBLE;
        refuted omitted. --fix: apply CONFIRMED in acceptEdits session → verify.
exit code: 2 if anything CONFIRMED, else 0.
```

## fabel research

```
decompose ─ 2..N sub-questions (structured)
sweep ───── explorer per sub-question (locate only)
deep-read ─ researcher per sub-question ([observed]/[inferred] + file:line)
synthesize─ one cited answer; contradictions resolved by reading, not majority
attack ──── skeptic per load-bearing claim (top 3, observed first)
            REFUTED claims weaken the answer and are reported as such
```

## fabel verify

```
commands = config.verify.commands > --cmd > auto-detect (npm/make/pytest/cargo)
run each; exit codes decide PASS/FAIL (deterministic layer)
--e2e: verifier agent exercises the changed behavior; may only downgrade
PASS → write .fabel/verified (consumed by the opt-in FABEL_STRICT commit gate)
```

## Cost controls

- `--budget` hard ceiling per run; per-stage `--max-budget-usd` from
  `budget.perStageUsd`; loop caps everywhere (dry rounds, max rounds).
- Role-based model routing (`models` in fabel.config.json): fan-out roles
  default to sonnet, judgment roles to opus; route to haiku for cheap sweeps.
- `--candidates 1` is the default — the judge panel is opt-in spend.
