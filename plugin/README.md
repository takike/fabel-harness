# fabel (plugin)

Fable-class orchestration for interactive Claude Code sessions. Part of
[fabel-harness](https://github.com/takike/fabel-harness); the sibling `fabel` CLI
drives the same agent personas headlessly.

## Commands

| Command | Pipeline |
|---|---|
| `/fabel:solve <task> [auto]` | explore (parallel) → plan (+skeptic attack) → implement → verify-fix loop → adversarial self-review → report |
| `/fabel:review [ref\|path]` | lens reviewers (parallel) → dedupe → one skeptic per finding → loop until 2 dry rounds → ranked report |
| `/fabel:research <question>` | explorer sweep → parallel deep-read → cited synthesis → skeptic attack on load-bearing claims |
| `/fabel:verify [cmd]` | end-to-end verification of the current diff; writes `.fabel/verified` on PASS |

## Agents

`explorer` `planner` `reviewer` `skeptic` `judge` `verifier` `researcher` — each
carries one Fable behavior (compact scouting, plan-first, full-recall finding
generation, adversarial refutation, anonymized scoring, evidence-based verification,
cited deep-reading). All are read-only except `verifier` (runs builds/tests).

## Skills

- `fabel:doctrine` — the behavior contract (plan-first, delegation triggers, evidence rules, honest reporting).
- `fabel:verification-protocol` — finding schema, dedupe, skeptic verdict semantics.
- `fabel:candidates` — multi-candidate worktree recipe with judge panels.

## Hooks

- **SessionStart** — one line of context announcing the commands. Nothing else.
- **PreToolUse (Bash)** — opt-in via `FABEL_STRICT=1`: non-blocking warning when
  `git commit` runs and the tree changed since the last `/fabel:verify` PASS.

## Install

```
claude plugin marketplace add takike/fabel-harness
/plugin install fabel@fabel-harness
```

Dev: `claude --plugin-dir ./plugin` from the repo root.
