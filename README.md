# fabel-harness

An agent harness on top of [Claude Code CLI](https://code.claude.com/docs) that makes
Opus / Sonnet reproduce **Fable-class** results through orchestration, adversarial
verification, and structured workflows — instead of raw model capability.

Fable-class behavior is mostly *discipline*: plan-first, parallel subagent fan-out,
adversarial verification of every finding, judge panels over independent candidates,
loop-until-dry review, mandatory end-to-end verification, and honest self-review.
This project encodes that discipline **outside** the model, so weaker models can ride it.

Two surfaces, one source of truth:

1. **Claude Code plugin (`fabel`)** — subagents, skills, slash commands, and hooks that
   upgrade interactive sessions (`/fabel:solve`, `/fabel:review`, `/fabel:research`, `/fabel:verify`).
2. **Wrapper CLI (`fabel`)** — a TypeScript orchestrator that drives `claude -p` (headless)
   subprocesses through deterministic pipelines: multi-candidate generation, judge panels,
   skeptic pools, and verify-fix loops.

Both consume the same agent personas in `plugin/agents/*.md`.

## Install

*(docs in progress — see milestones in the repo history)*

```bash
# Plugin (interactive sessions)
claude plugin marketplace add takike/fabel-harness
/plugin install fabel@fabel-harness

# CLI (headless orchestration)
npm install -g fabel-harness
fabel doctor
```

## Status

Under active initial development.
