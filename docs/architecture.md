# Architecture

fabel-harness reproduces Fable-class behavior on Opus/Sonnet by moving the
discipline — plan-first, fan-out, adversarial verification, judged candidates,
mandatory end-to-end verification — out of the model and into a harness.

## Two surfaces, one source of truth

```
plugin/agents/*.md      ← personas (single source of truth)
plugin/skills/*.md      ← protocols (doctrine, verification, candidates)
        │
        ├─ interactive: Claude Code loads them as a plugin
        │  (/fabel:solve, /fabel:review, ... orchestrated BY the model)
        │
        └─ headless: the fabel CLI parses the same markdown
           (promptSource.ts) and injects it into `claude -p` calls
           (pipelines orchestrated by deterministic TypeScript)
```

The pipelines are intentionally defined twice — interactive commands are
model-driven, CLI pipelines are code-driven — but personas and protocols exist
only once. A drift-guard test (`test/plugin.test.ts`) fails if a command
references an agent or skill that doesn't exist.

## CLI layering

```
src/cli.ts                    commander dispatch
src/commands/                 one pipeline per command (solve/review/research/verify/doctor)
src/engine/
  claudeRunner.ts             THE subprocess boundary: spawn claude -p, parse
                              stream-json, sessions/resume, per-stage budget caps,
                              structured-output validation (zod), --bare fallback
  promptSource.ts             plugin markdown → system prompts / --agents JSON
  budget.ts                   cumulative cost ceiling; BudgetExceededError
  runState.ts                 .fabel/runs/<id>/ state.json + raw NDJSON per call
  parallel.ts                 bounded-concurrency fan-out (FABEL_CONCURRENCY)
  findings.ts                 finding dedupe (file+line+summary similarity)
  loopUntilDry.ts             K-consecutive-empty-rounds discovery loop
  skepticPool.ts              one skeptic per finding; failure degrades to PLAUSIBLE
  judgePanel.ts               anonymized seats, median rank, tie-break protocol
  worktree.ts                 candidate worktrees: clean-tree gate, SHA-pinned base,
                              squash-merge winner, forced cleanup
  verifyLoop.ts               verify → resume implement session with failure → retry
src/report/
  schemas.ts                  zod schemas + matching JSON Schemas for --json-schema
  render.ts                   lead-with-outcome markdown reports
```

## Trust rules (the load-bearing decisions)

1. **Machine-consumed output is never prose-parsed.** Every judge/skeptic/plan/
   findings stage passes `--json-schema` and validates `structured_output` with
   zod; invalid output is retried once, then dropped with a note.
2. **The deterministic layer outranks the model on verification.** When verify
   commands are configured, their exit codes decide PASS/FAIL; the verifier agent
   can only downgrade (PASS→PARTIAL/FAIL), never upgrade.
3. **Verification failures never upgrade findings.** A skeptic call that fails
   degrades its finding to PLAUSIBLE — it is reported as unverified, not dropped
   and not confirmed. An unevidenced CONFIRMED is downgraded to PLAUSIBLE.
4. **Budgets are hard.** `--budget` is enforced before every stage; exhaustion
   ends the run with a partial report, never an exception to the user.
5. **Permission tiers.** Read-only workers: `--permission-mode dontAsk` + a
   read-only Bash allowlist (`READONLY_BASH_ALLOWLIST`). Write stages:
   `acceptEdits` + `permissions.extraAllowedTools` from config.
   `bypassPermissions` exists only behind `--yolo` and only inside
   fabel-created disposable worktrees.

## Auth note

`--bare` (used for worker determinism) requires `ANTHROPIC_API_KEY`. Under
subscription/OAuth credentials the runner detects the auth error once and
falls back to non-bare worker calls for the rest of the run.

## Run state

Every run writes `.fabel/runs/<id>/state.json` (stage graph, session ids, per-
stage cost) plus one raw `NNN-label.ndjson` transcript per claude call — the
basis for cost reporting, debugging, and post-hoc auditing. Add `.fabel/` to
your project's `.gitignore`.
