import type { ClaudeRunner } from './claudeRunner.js';
import type { FabelConfig } from '../config.js';
import { modelForRole, effortForRole } from '../config.js';
import { runVerify, type VerifyReport } from '../commands/verify.js';

export interface VerifyLoopResult {
  pass: boolean;
  rounds: number;
  last?: VerifyReport;
  /** Session id of the implement conversation after any fix rounds. */
  sessionId?: string;
}

/**
 * verify → feed failure back into the implement session → re-verify, until PASS
 * or maxRounds. Resuming the same session keeps the implementer's context so fix
 * rounds don't re-learn the codebase.
 */
export async function runVerifyFixLoop(
  runner: ClaudeRunner,
  ctx: {
    cwd: string;
    config: FabelConfig;
    sessionId?: string;
    maxRounds: number;
    cmd?: string;
    onProgress?: (line: string) => void;
  },
): Promise<VerifyLoopResult> {
  let sessionId = ctx.sessionId;
  let last: VerifyReport | undefined;
  for (let round = 1; round <= ctx.maxRounds; round++) {
    last = await runVerify({ cwd: ctx.cwd, cmd: ctx.cmd, onProgress: ctx.onProgress });
    if (last.verdict !== 'FAIL') {
      return { pass: last.verdict === 'PASS', rounds: round, last, sessionId };
    }
    if (round === ctx.maxRounds) break;

    const failures = last.commands
      .filter((c) => c.exitCode !== 0)
      .map((c) => `$ ${c.command} → exit ${c.exitCode}\n${c.outputTail.split('\n').slice(-30).join('\n')}`)
      .join('\n\n');
    const fix = await runner.runStage({
      label: `fix:r${round}`,
      prompt: `The verification failed. Diagnose from the output below, fix the root cause (not the symptom), and stop — verification runs again after you finish.\n\n${failures}`,
      model: modelForRole(ctx.config, 'implement'),
      effort: effortForRole(ctx.config, 'implement'),
      permissionMode: 'acceptEdits',
      allowedTools: ctx.config.permissions.extraAllowedTools,
      maxBudgetUsd: ctx.config.budget.perStageUsd,
      resume: sessionId,
      cwd: ctx.cwd,
    });
    if (!fix.ok) return { pass: false, rounds: round, last, sessionId };
    sessionId = fix.sessionId ?? sessionId;
  }
  return { pass: false, rounds: ctx.maxRounds, last, sessionId };
}
