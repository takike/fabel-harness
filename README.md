# fabel-harness

An agent harness on top of [Claude Code CLI](https://code.claude.com/docs) that makes
Opus / Sonnet reproduce **Fable-class** results through orchestration, adversarial
verification, and structured workflows — instead of raw model capability.

Fable-class behavior is mostly *discipline*: plan-first, parallel subagent fan-out,
adversarial verification of every finding, judge panels over independent candidates,
loop-until-dry review, mandatory end-to-end verification, and honest self-review.
This project encodes that discipline **outside** the model, so weaker models can ride it.

Two surfaces, one source of truth (`plugin/agents/*.md`):

1. **Claude Code plugin (`fabel`)** — subagents, skills, slash commands, and hooks that
   upgrade interactive sessions.
2. **Wrapper CLI (`fabel`)** — a TypeScript orchestrator driving `claude -p` (headless)
   through deterministic pipelines: candidate generation, judge panels, skeptic pools,
   verify-fix loops, hard budgets.

## Install

```bash
# Plugin (interactive sessions)
claude plugin marketplace add takike/fabel-harness
/plugin install fabel@fabel-harness

# CLI (headless orchestration) — from a clone until published to npm
npm install && npm run build && npm link
fabel doctor
```

Plugin dev-mode without installing: `claude --plugin-dir ./plugin`.

## Interactive commands (plugin)

| Command | Pipeline |
|---|---|
| `/fabel:solve <task> [auto]` | explore (parallel) → plan (skeptic-attacked) → implement → verify-fix loop → adversarial self-review |
| `/fabel:review [ref\|path]` | lens reviewers in parallel → dedupe → one skeptic per finding → loop until 2 dry rounds → ranked report |
| `/fabel:research <question>` | explorer sweep → parallel cited deep-read → synthesis → skeptic attack on load-bearing claims |
| `/fabel:verify [cmd]` | evidence-based end-to-end verification; records `.fabel/verified` on PASS |

Skills: `fabel:doctrine` (the behavior contract), `fabel:verification-protocol`
(finding lifecycle), `fabel:candidates` (worktree best-of-N recipe).

## Headless commands (CLI)

```
fabel solve "task"  [--candidates N] [--judges M] [--plan-only] [--max-rounds R]
                    [--budget USD] [--model opus] [--effort xhigh] [--base REF]
                    [--keep-worktrees] [--yolo] [--cmd "npm test"] [--json]
fabel review        [--base REF] [--lenses correctness,security,...]
                    [--dry-rounds K] [--max-rounds R] [--budget USD] [--fix] [--json]
fabel research "q"  [--sweep N] [--budget USD] [--json]
fabel verify        [--cmd "npm test"] [--e2e] [--budget USD] [--json]
fabel doctor        [--json]
```

- `fabel review` exits 2 when findings are CONFIRMED — CI-friendly.
- `--candidates N` implements the task N ways in parallel git worktrees with
  differentiated stances, scores them on an anonymized judge panel (median rank),
  and squash-merges the winner (staged, uncommitted).
- Every run writes `.fabel/runs/<id>/` (stage costs, session ids, raw transcripts).
  Add `.fabel/` to your `.gitignore`.

## Configuration — `fabel.config.json` (all optional)

```json
{
  "models":  { "implement": "opus", "reviewer": "opus", "skeptic": "opus",
               "explorer": "sonnet", "verifier": "sonnet", "judge": "opus" },
  "effort":  { "implement": "xhigh", "default": "high" },
  "verify":  { "commands": ["npm test", "npm run build"], "timeoutSec": 600 },
  "budget":  { "defaultUsd": 10, "perStageUsd": 3 },
  "review":  { "lenses": ["correctness", "security", "concurrency", "tests"],
               "dryRounds": 2, "maxRounds": 4 },
  "permissions": { "extraAllowedTools": ["Bash(npm test:*)", "Bash(node -e:*)"] }
}
```

Notes:
- Fan-out roles default to sonnet, judgment roles to opus; route to haiku for
  cheap sweeps.
- Read-only workers run under `--permission-mode dontAsk` with a built-in
  read-only Bash allowlist (git diff/log/show/…). Add `"Bash(node -e:*)"` to
  `permissions.extraAllowedTools` if you want skeptics to *execute* repros.
- `--bare` worker calls need `ANTHROPIC_API_KEY`; with subscription/OAuth auth
  the runner detects this and falls back to non-bare automatically.
- Opt-in commit gate: `FABEL_STRICT=1` warns (never blocks) on `git commit`
  when the tree changed since the last verified state.

## Development

```bash
npm test            # offline suite — a fake `claude` binary replays scripted
                    # stream-json scenarios; no API key needed
npm run test:live   # FABEL_LIVE=1 — real claude; reviews a planted-bug fixture
npm run build       # tsc → dist/
```

Docs: [architecture](docs/architecture.md) · [pipelines](docs/pipelines.md)

## License

MIT
