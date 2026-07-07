import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { loadConfig, modelForRole, effortForRole } from '../config.js';
import { ClaudeRunner } from '../engine/claudeRunner.js';
import { Budget, BudgetExceededError } from '../engine/budget.js';
import { RunState } from '../engine/runState.js';
import { defaultPluginDir, loadAgent, loadSkillBody } from '../engine/promptSource.js';
import { loopUntilDry } from '../engine/loopUntilDry.js';
import { dedupeNew } from '../engine/findings.js';
import { verifyFindings, type VerifiedFinding } from '../engine/skepticPool.js';
import { mapLimit, defaultConcurrency } from '../engine/parallel.js';
import { FindingsReportSchema, FINDINGS_JSON_SCHEMA, type Finding } from '../report/schemas.js';
import { renderReviewReport } from '../report/render.js';
import { runVerify, type VerifyReport } from './verify.js';

export interface ReviewOptions {
  cwd?: string;
  /** Diff base ref; undefined reviews the working tree vs HEAD. */
  base?: string;
  lenses?: string[];
  dryRounds?: number;
  maxRounds?: number;
  budgetUsd?: number;
  /** Apply CONFIRMED fixes in an acceptEdits session, then re-verify. */
  fix?: boolean;
  onProgress?: (line: string) => void;
}

export interface ReviewReport {
  scope: string;
  confirmed: VerifiedFinding[];
  plausible: VerifiedFinding[];
  refuted: number;
  rounds: number;
  hitCap: boolean;
  budgetExhausted: boolean;
  costUsd: number;
  runId: string;
  fix?: { applied: boolean; detail: string; verify?: VerifyReport };
  notes: string[];
}

function describeScope(cwd: string, base?: string): string {
  const ref = base ?? 'HEAD';
  const stat = spawnSync('git', ['diff', '--stat', ref], { cwd }).stdout?.toString().trim() ?? '';
  return `Scope: the diff from \`git diff ${ref}\` in ${cwd}.` + (stat ? `\nDiff stat:\n${stat}` : '\n(The diff is currently empty — review the most recent commit instead: git show HEAD.)');
}

export async function runReview(opts: ReviewOptions = {}): Promise<ReviewReport> {
  const cwd = opts.cwd ?? process.cwd();
  const config = loadConfig(cwd);
  const lenses = opts.lenses ?? config.review.lenses;
  const dryRounds = opts.dryRounds ?? config.review.dryRounds;
  const maxRounds = opts.maxRounds ?? config.review.maxRounds;

  const pluginDir = defaultPluginDir();
  const reviewer = loadAgent(pluginDir, 'reviewer');
  const skeptic = loadAgent(pluginDir, 'skeptic');
  const doctrine = loadSkillBody(pluginDir, 'doctrine');
  const protocol = loadSkillBody(pluginDir, 'verification-protocol');

  const budget = new Budget(opts.budgetUsd ?? config.budget.defaultUsd);
  const runState = RunState.create(cwd, 'review', { base: opts.base, lenses, dryRounds, maxRounds });
  const runner = new ClaudeRunner({ budget, runState, onProgress: opts.onProgress });

  const scope = describeScope(cwd, opts.base);
  const seen: Finding[] = [];
  const verified: VerifiedFinding[] = [];
  const notes: string[] = [];
  let budgetExhausted = false;

  const result = await loopUntilDry<VerifiedFinding>(
    async (roundNum) => {
      // 1. Find — one reviewer per lens, in parallel.
      const alreadyFound = seen.length
        ? `\n\nAlready found in earlier rounds (do NOT re-report; hunt fresh territory):\n${seen.map((f) => `- ${f.file}:${f.line} ${f.summary}`).join('\n')}`
        : '';
      let reports: (Finding[] | null)[];
      try {
        reports = await mapLimit(lenses, defaultConcurrency(), async (lens) => {
          const structured = await runner.runStructured(
            {
              label: `reviewer:${lens}:r${roundNum}`,
              prompt: `Review through EXACTLY this lens: ${lens}. This is round ${roundNum}/${maxRounds}.\n\n${scope}\n\nReport every issue you find — recall over precision; a downstream skeptic filters.${alreadyFound}`,
              systemPrompt: `${reviewer.prompt}\n\n---\n\n${doctrine}`,
              model: modelForRole(config, 'reviewer'),
              effort: effortForRole(config, 'reviewer'),
              bare: true,
              tools: reviewer.tools,
              permissionMode: 'dontAsk',
              maxBudgetUsd: config.budget.perStageUsd,
              jsonSchema: FINDINGS_JSON_SCHEMA,
              cwd,
            },
            FindingsReportSchema,
          );
          return structured ? structured.value.findings.map((f) => ({ ...f, lens })) : null;
        });
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          budgetExhausted = true;
          return [];
        }
        throw e;
      }
      const dropped = reports.filter((r) => r === null).length;
      if (dropped) notes.push(`round ${roundNum}: ${dropped} lens call(s) produced no valid findings output`);

      // 2. Dedupe against everything ever seen.
      const fresh = dedupeNew(reports.filter((r): r is Finding[] => r !== null).flat(), seen);
      seen.push(...fresh);
      if (!fresh.length) return [];

      // 3. Verify — one skeptic per fresh finding.
      let verdicts: VerifiedFinding[];
      try {
        verdicts = await verifyFindings(runner, fresh, {
          skeptic,
          protocol,
          scopeDescription: scope,
          cwd,
          model: modelForRole(config, 'skeptic'),
          effort: effortForRole(config, 'skeptic'),
          perStageUsd: config.budget.perStageUsd,
        });
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          budgetExhausted = true;
          return [];
        }
        throw e;
      }
      verified.push(...verdicts);
      if (budget.exhausted()) budgetExhausted = true;
      return budgetExhausted ? [] : verdicts.filter((v) => v.verdict === 'CONFIRMED');
    },
    { dryRounds, maxRounds },
  );

  const confirmed = verified.filter((v) => v.verdict === 'CONFIRMED');
  const plausible = verified.filter((v) => v.verdict === 'PLAUSIBLE');
  const refuted = verified.filter((v) => v.verdict === 'REFUTED').length;
  if (budgetExhausted) notes.push('budget exhausted — coverage is partial');

  const report: ReviewReport = {
    scope,
    confirmed,
    plausible,
    refuted,
    rounds: result.rounds,
    hitCap: result.hitCap,
    budgetExhausted,
    costUsd: budget.spent(),
    runId: runState.id,
    notes,
  };

  if (opts.fix && confirmed.length && !budgetExhausted) {
    report.fix = await applyFixes(runner, confirmed, { cwd, config, doctrine });
    report.costUsd = budget.spent();
  }

  runState.finish({
    confirmed: confirmed.length,
    plausible: plausible.length,
    refuted,
    rounds: result.rounds,
    costUsd: budget.spent(),
  });
  return report;
}

async function applyFixes(
  runner: ClaudeRunner,
  confirmed: VerifiedFinding[],
  ctx: { cwd: string; config: ReturnType<typeof loadConfig>; doctrine: string },
): Promise<NonNullable<ReviewReport['fix']>> {
  const list = confirmed
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.file}:${f.line} — ${f.summary}\n   Scenario: ${f.failure_scenario}\n   Skeptic evidence: ${f.verdictEvidence}`)
    .join('\n');
  const stage = await runner.runStage({
    label: 'fix',
    prompt: `Fix the following confirmed code-review findings. Make the smallest change that fully fixes each; follow the surrounding code's conventions; do not fix anything not listed.\n\n${list}`,
    systemPrompt: ctx.doctrine,
    model: modelForRole(ctx.config, 'implement'),
    effort: effortForRole(ctx.config, 'implement'),
    permissionMode: 'acceptEdits',
    allowedTools: ctx.config.permissions.extraAllowedTools,
    maxBudgetUsd: ctx.config.budget.perStageUsd,
    cwd: ctx.cwd,
  });
  if (!stage.ok) {
    return { applied: false, detail: `fix session failed: ${stage.errorMessage ?? 'unknown'}` };
  }
  const verify = await runVerify({ cwd: ctx.cwd });
  return { applied: true, detail: stage.resultText.slice(0, 500), verify };
}

export function registerReview(program: Command, progress: (line: string) => void): void {
  program
    .command('review')
    .description('adversarial review: lens reviewers in parallel, one skeptic per finding, loop until dry')
    .option('--base <ref>', 'diff base (default: working tree vs HEAD)')
    .option('--lenses <list>', 'comma-separated lenses', (v: string) => v.split(',').map((s) => s.trim()))
    .option('--dry-rounds <n>', 'consecutive empty rounds before stopping', (v: string) => parseInt(v, 10))
    .option('--max-rounds <n>', 'hard round cap', (v: string) => parseInt(v, 10))
    .option('--budget <usd>', 'cost ceiling', parseFloat)
    .option('--fix', 'apply CONFIRMED fixes, then re-verify')
    .option('--json', 'machine-readable output')
    .action(async (opts: { base?: string; lenses?: string[]; dryRounds?: number; maxRounds?: number; budget?: number; fix?: boolean; json?: boolean }) => {
      const report = await runReview({
        base: opts.base,
        lenses: opts.lenses,
        dryRounds: opts.dryRounds,
        maxRounds: opts.maxRounds,
        budgetUsd: opts.budget,
        fix: opts.fix,
        onProgress: opts.json ? undefined : progress,
      });
      if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      else process.stdout.write(renderReviewReport(report) + '\n');
      process.exitCode = report.confirmed.length ? 2 : 0;
    });
}
