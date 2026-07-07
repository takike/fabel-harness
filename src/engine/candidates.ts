import type { ClaudeRunner } from './claudeRunner.js';
import type { AgentDef } from './promptSource.js';
import type { FabelConfig } from '../config.js';
import { modelForRole, effortForRole, workerAllowedTools } from '../config.js';
import { mapLimit } from './parallel.js';
import {
  createCandidateWorktrees,
  commitCandidateWork,
  candidateDiff,
  mergeWinner,
  removeCandidateWorktrees,
} from './worktree.js';
import { runJudgePanel, type JudgePanelResult } from './judgePanel.js';
import { runVerify } from '../commands/verify.js';

/** Differentiated stances — identical prompts would produce redundant candidates. */
export const CANDIDATE_ANGLES: Array<{ key: string; stance: string }> = [
  { key: 'minimal-change', stance: 'Make the SMALLEST diff that fully solves the task. No refactors, no drive-by cleanups.' },
  { key: 'refactor-first', stance: 'First restructure the touched code so the fix becomes natural and obvious, then apply it.' },
  { key: 'test-first', stance: 'Write the failing tests that pin the desired behavior FIRST, then implement until they pass.' },
  { key: 'defensive', stance: 'Prioritize edge cases, input validation, and error paths; harden while you implement.' },
];

export interface CandidatesPhaseOptions {
  task: string;
  planJson: string;
  digest: string;
  cwd: string;
  runId: string;
  count: number;
  judges: number;
  base: string;
  keepWorktrees?: boolean;
  model?: string;
  effort?: string;
  /** Run candidate sessions with bypassPermissions inside their disposable worktrees. */
  yolo?: boolean;
  cmd?: string;
}

export interface CandidatesPhaseResult {
  merged: boolean;
  winnerIndex: number;
  winnerAngle: string;
  panel: JudgePanelResult;
  perCandidate: Array<{ angle: string; implemented: boolean; committed: boolean; verifyVerdict: string }>;
  notes: string[];
}

export async function runCandidatesPhase(
  runner: ClaudeRunner,
  config: FabelConfig,
  personas: { judge: AgentDef; doctrine: string },
  opts: CandidatesPhaseOptions,
): Promise<CandidatesPhaseResult> {
  const notes: string[] = [];
  const angles = Array.from({ length: opts.count }, (_, i) => CANDIDATE_ANGLES[i % CANDIDATE_ANGLES.length]!);
  const worktrees = createCandidateWorktrees(opts.cwd, opts.runId, opts.count, opts.base);

  try {
    // Independent implementations, one per worktree, no knowledge of each other.
    const perCandidate = await mapLimit(worktrees, 2, async (wt) => {
      const angle = angles[wt.index]!;
      const stage = await runner.runStage({
        label: `candidate:${wt.index}:${angle.key}`,
        prompt: [
          `Implement the following task. Your stance: ${angle.stance}`,
          `Task: ${opts.task}`,
          `Plan (adapt to your stance where they conflict; the task wins over the plan):\n${opts.planJson}`,
          `Explorer digests (facts about this codebase):\n${opts.digest}`,
          `Work only inside this directory. Do NOT commit; committing is handled outside.`,
        ].join('\n\n'),
        systemPrompt: personas.doctrine,
        model: opts.model ?? modelForRole(config, 'implement'),
        effort: opts.effort ?? effortForRole(config, 'implement'),
        permissionMode: opts.yolo ? 'bypassPermissions' : 'acceptEdits',
        allowedTools: config.permissions.extraAllowedTools,
        maxBudgetUsd: config.budget.perStageUsd,
        cwd: wt.path,
      });
      const committed = commitCandidateWork(wt, `fabel candidate ${wt.index} (${angle.key})`);
      let verifyVerdict = 'SKIPPED';
      if (stage.ok && committed) {
        const v = await runVerify({ cwd: wt.path, cmd: opts.cmd });
        verifyVerdict = v.verdict;
      }
      return { angle: angle.key, implemented: stage.ok, committed, verifyVerdict };
    });

    // Judge panel over anonymized diffs (verify verdicts included in the rubric note).
    const diffs = worktrees.map((wt) => candidateDiff(wt));
    const panel = await runJudgePanel(
      runner,
      diffs,
      {
        judge: personas.judge,
        cwd: opts.cwd,
        model: modelForRole(config, 'judge'),
        effort: effortForRole(config, 'judge'),
        perStageUsd: config.budget.perStageUsd,
        rubricNote: `Task being solved: ${opts.task}`,
        allowedTools: workerAllowedTools(config),
      },
      opts.judges,
    );
    notes.push(...panel.notes);

    const winner = worktrees[panel.winner]!;
    const merge = mergeWinner(opts.cwd, winner);
    notes.push(merge.detail);
    return {
      merged: merge.ok,
      winnerIndex: panel.winner,
      winnerAngle: angles[panel.winner]!.key,
      panel,
      perCandidate,
      notes,
    };
  } finally {
    removeCandidateWorktrees(opts.cwd, worktrees, opts.keepWorktrees);
    if (opts.keepWorktrees) notes.push(`worktrees kept under .fabel/worktrees/${opts.runId}/`);
  }
}
