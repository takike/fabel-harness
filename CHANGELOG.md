# Changelog

## 0.1.0 (unreleased)

Initial release.

- **Claude Code plugin (`fabel`)**: 7 agent personas (explorer, planner, reviewer,
  skeptic, judge, verifier, researcher), 4 commands (`/fabel:solve`, `/fabel:review`,
  `/fabel:research`, `/fabel:verify`), 3 skills (doctrine, verification-protocol,
  candidates), minimal hooks (SessionStart notice, opt-in `FABEL_STRICT` commit gate).
- **Wrapper CLI (`fabel`)**: headless pipelines driving `claude -p` —
  `solve` (explore → skeptic-attacked plan → implement → verify-fix loop →
  adversarial self-review, with `--candidates N` worktree + judge-panel mode),
  `review` (lens reviewers → skeptic per finding → loop-until-dry, `--fix`),
  `research` (decompose → sweep → cited deep-read → synthesis → claim attack),
  `verify` (deterministic commands + optional `--e2e` verifier agent), `doctor`.
- Hard budgets with partial-result degradation, `.fabel/runs/` state + transcripts,
  structured output enforced via `--json-schema` + zod, read-only Bash allowlist for
  `dontAsk` workers, automatic `--bare` fallback under subscription/OAuth auth.
- Offline test suite against a scripted fake `claude` binary; opt-in live smoke
  (`FABEL_LIVE=1`) against a planted-bug fixture repo.
