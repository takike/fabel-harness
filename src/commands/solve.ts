import type { Command } from 'commander';
import { loadConfig, modelForRole, effortForRole, type FabelConfig } from '../config.js';
import { ClaudeRunner } from '../engine/claudeRunner.js';
import { Budget, BudgetExceededError } from '../engine/budget.js';
import { RunState } from '../engine/runState.js';
import { defaultPluginDir, loadAgent, loadSkillBody, type AgentDef } from '../engine/promptSource.js';
import { mapLimit, defaultConcurrency } from '../engine/parallel.js';
import { runVerifyFixLoop, type VerifyLoopResult } from '../engine/verifyLoop.js';
import { verifyFindings, type VerifiedFinding } from '../engine/skepticPool.js';
import { runCandidatesPhase, type CandidatesPhaseResult } from '../engine/candidates.js';
import {
  PlanSchema,
  PLAN_JSON_SCHEMA,
  VerdictSchema,
  VERDICT_JSON_SCHEMA,
  FindingsReportSchema,
  FINDINGS_JSON_SCHEMA,
  type Plan,
  type Verdict,
} from '../report/schemas.js';
import { renderSolveReport } from '../report/render.js';

export interface SolveOptions {
  task: string;
  cwd?: string;
  /** Stop after printing the (attacked) plan. */
  planOnly?: boolean;
  maxRounds?: number;
  budgetUsd?: number;
  /** Implement-stage model override. */
  model?: string;
  effort?: string;
  cmd?: string;
  /** N>1 enables multi-candidate mode (worktrees + judge panel). */
  candidates?: number;
  judges?: number;
  base?: string;
  keepWorktrees?: boolean;
  /** bypassPermissions inside disposable candidate worktrees only. */
  yolo?: boolean;
  onProgress?: (line: string) => void;
}

export interface SolveReport {
  outcome: 'completed' | 'failed-verification' | 'plan-only' | 'budget-exhausted' | 'error';
  task: string;
  plan: Plan | null;
  planAttack: Verdict | null;
  implementSummary: string;
  verify: VerifyLoopResult | null;
  selfReview: { confirmed: VerifiedFinding[]; plausible: VerifiedFinding[]; refuted: number; fixed: boolean } | null;
  candidates: CandidatesPhaseResult | null;
  costUsd: number;
  runId: string;
  notes: string[];
}

interface Personas {
  explorer: AgentDef;
  planner: AgentDef;
  reviewer: AgentDef;
  skeptic: AgentDef;
  judge: AgentDef;
  doctrine: string;
  protocol: string;
}

const EXPLORE_SLICES: Array<{ key: string; brief: string }> = [
  { key: 'modules', brief: 'the modules, entry points, and code paths this task will touch' },
  { key: 'tests', brief: 'the test layout for the affected area and how tests are run' },
  { key: 'conventions', brief: 'codebase conventions and existing reusable utilities relevant to the task' },
];

export async function runSolve(opts: SolveOptions): Promise<SolveReport> {
  const cwd = opts.cwd ?? process.cwd();
  const config = loadConfig(cwd);
  const maxRounds = opts.maxRounds ?? 3;

  const pluginDir = defaultPluginDir();
  const personas: Personas = {
    explorer: loadAgent(pluginDir, 'explorer'),
    planner: loadAgent(pluginDir, 'planner'),
    reviewer: loadAgent(pluginDir, 'reviewer'),
    skeptic: loadAgent(pluginDir, 'skeptic'),
    judge: loadAgent(pluginDir, 'judge'),
    doctrine: loadSkillBody(pluginDir, 'doctrine'),
    protocol: loadSkillBody(pluginDir, 'verification-protocol'),
  };

  const budget = new Budget(opts.budgetUsd ?? config.budget.defaultUsd);
  const runState = RunState.create(cwd, 'solve', { task: opts.task, maxRounds });
  const runner = new ClaudeRunner({ budget, runState, onProgress: opts.onProgress });

  const report: SolveReport = {
    outcome: 'error',
    task: opts.task,
    plan: null,
    planAttack: null,
    implementSummary: '',
    verify: null,
    selfReview: null,
    candidates: null,
    costUsd: 0,
    runId: runState.id,
    notes: [],
  };

  try {
    // 1. Explore — parallel scouts, distinct slices.
    const digests = await mapLimit(EXPLORE_SLICES, defaultConcurrency(), async (slice) => {
      const r = await runner.runStage({
        label: `explore:${slice.key}`,
        prompt: `Task under consideration: ${opts.task}\n\nYour slice: ${slice.brief}. Map it per your return format.`,
        systemPrompt: personas.explorer.prompt,
        model: modelForRole(config, 'explorer'),
        effort: effortForRole(config, 'explorer'),
        bare: true,
        tools: personas.explorer.tools,
        permissionMode: 'dontAsk',
        maxBudgetUsd: config.budget.perStageUsd,
        cwd,
      });
      return r.ok ? `## slice: ${slice.key}\n${r.resultText}` : `## slice: ${slice.key}\n(exploration failed: ${r.errorMessage})`;
    });
    const digest = digests.join('\n\n');

    // 2. Plan — structured, then attacked by a skeptic.
    const planStage = await runner.runStructured(
      {
        label: 'plan',
        prompt: `Design the implementation plan for this task.\n\nTask: ${opts.task}\n\nExplorer digests:\n${digest}`,
        systemPrompt: `${personas.planner.prompt}\n\n---\n\n${personas.doctrine}`,
        model: modelForRole(config, 'planner'),
        effort: effortForRole(config, 'planner'),
        bare: true,
        tools: personas.planner.tools,
        permissionMode: 'dontAsk',
        maxBudgetUsd: config.budget.perStageUsd,
        jsonSchema: PLAN_JSON_SCHEMA,
        cwd,
      },
      PlanSchema,
    );
    if (!planStage) {
      report.notes.push('planner produced no valid plan');
      return finish(report, runState, budget);
    }
    let plan = planStage.value;

    const attack = await runner.runStructured(
      {
        label: 'plan-attack',
        prompt: `Adversarially attack this implementation plan: what breaks if it is implemented exactly as written? CONFIRMED = you found a concrete problem that will break it (cite code); REFUTED = the plan holds; PLAUSIBLE = uncertain.\n\nTask: ${opts.task}\n\nPlan:\n${JSON.stringify(plan, null, 2)}`,
        systemPrompt: `${personas.skeptic.prompt}\n\n---\n\n${personas.doctrine}`,
        model: modelForRole(config, 'skeptic'),
        effort: effortForRole(config, 'skeptic'),
        bare: true,
        tools: personas.skeptic.tools,
        permissionMode: 'dontAsk',
        maxBudgetUsd: config.budget.perStageUsd,
        jsonSchema: VERDICT_JSON_SCHEMA,
        cwd,
      },
      VerdictSchema,
    );
    report.planAttack = attack?.value ?? null;

    if (attack?.value.verdict === 'CONFIRMED') {
      const revised = await runner.runStructured(
        {
          label: 'plan-revise',
          prompt: `Revise the implementation plan to resolve a confirmed objection.\n\nTask: ${opts.task}\n\nCurrent plan:\n${JSON.stringify(plan, null, 2)}\n\nConfirmed objection:\n${attack.value.evidence}\n\nExplorer digests:\n${digest}`,
          systemPrompt: `${personas.planner.prompt}\n\n---\n\n${personas.doctrine}`,
          model: modelForRole(config, 'planner'),
          effort: effortForRole(config, 'planner'),
          bare: true,
          tools: personas.planner.tools,
          permissionMode: 'dontAsk',
          maxBudgetUsd: config.budget.perStageUsd,
          jsonSchema: PLAN_JSON_SCHEMA,
          cwd,
        },
        PlanSchema,
      );
      if (revised) plan = revised.value;
      else report.notes.push('plan revision failed; proceeding with the attacked plan');
    }
    report.plan = plan;

    if (opts.planOnly) {
      report.outcome = 'plan-only';
      return finish(report, runState, budget);
    }

    // 3. Implement — single session, or N worktree candidates + judge panel.
    let implementSessionId: string | undefined;
    if ((opts.candidates ?? 1) > 1) {
      report.candidates = await runCandidatesPhase(
        runner,
        config,
        { judge: personas.judge, doctrine: personas.doctrine },
        {
          task: opts.task,
          planJson: JSON.stringify(plan, null, 2),
          digest,
          cwd,
          runId: runState.id,
          count: opts.candidates!,
          judges: opts.judges ?? 3,
          base: opts.base ?? 'HEAD',
          keepWorktrees: opts.keepWorktrees,
          model: opts.model,
          effort: opts.effort,
          yolo: opts.yolo,
          cmd: opts.cmd,
        },
      );
      report.notes.push(...report.candidates.notes);
      report.implementSummary = `winner: candidate ${report.candidates.winnerIndex} (${report.candidates.winnerAngle}), median ranks [${report.candidates.panel.medianRanks.join(', ')}]`;
      if (!report.candidates.merged) {
        report.notes.push('winner merge failed — resolve manually or rerun with --keep-worktrees to inspect');
        return finish(report, runState, budget);
      }
    } else {
      const implement = await runner.runStage({
        label: 'implement',
        prompt: [
          `Implement the following task, following the plan exactly. If a step proves wrong, adapt minimally and say so in your summary.`,
          `Task: ${opts.task}`,
          `Plan:\n${JSON.stringify(plan, null, 2)}`,
          `Explorer digests (facts about this codebase):\n${digest}`,
          `Do NOT commit. Stop after the change is complete; verification runs separately.`,
        ].join('\n\n'),
        systemPrompt: personas.doctrine,
        model: opts.model ?? modelForRole(config, 'implement'),
        effort: opts.effort ?? effortForRole(config, 'implement'),
        permissionMode: 'acceptEdits',
        allowedTools: config.permissions.extraAllowedTools,
        maxBudgetUsd: config.budget.perStageUsd,
        cwd,
      });
      report.implementSummary = implement.resultText;
      if (!implement.ok) {
        report.notes.push(`implement stage failed: ${implement.errorMessage ?? 'unknown'}`);
        return finish(report, runState, budget);
      }
      implementSessionId = implement.sessionId;
    }

    // 4. Verify-fix loop (in the main tree; fix rounds start fresh in candidate mode).
    report.verify = await runVerifyFixLoop(runner, {
      cwd,
      config,
      sessionId: implementSessionId,
      maxRounds,
      cmd: opts.cmd,
      onProgress: opts.onProgress,
    });
    if (!report.verify.pass) {
      report.outcome = 'failed-verification';
      return finish(report, runState, budget);
    }

    // 5. Self-review — correctness reviewer, skeptic per finding, fix, re-verify.
    const review = await runner.runStructured(
      {
        label: 'self-review',
        prompt: `Review through EXACTLY this lens: correctness.\n\nScope: the working-tree diff (git diff HEAD) in ${cwd} — the change just implemented for: ${opts.task}\n\nReport every issue you find — recall over precision; a downstream skeptic filters.`,
        systemPrompt: `${personas.reviewer.prompt}\n\n---\n\n${personas.doctrine}`,
        model: modelForRole(config, 'reviewer'),
        effort: effortForRole(config, 'reviewer'),
        bare: true,
        tools: personas.reviewer.tools,
        permissionMode: 'dontAsk',
        maxBudgetUsd: config.budget.perStageUsd,
        jsonSchema: FINDINGS_JSON_SCHEMA,
        cwd,
      },
      FindingsReportSchema,
    );
    if (review && review.value.findings.length) {
      const verdicts = await verifyFindings(runner, review.value.findings, {
        skeptic: personas.skeptic,
        protocol: personas.protocol,
        scopeDescription: `Scope: the working-tree diff (git diff HEAD) in ${cwd}.`,
        cwd,
        model: modelForRole(config, 'skeptic'),
        effort: effortForRole(config, 'skeptic'),
        perStageUsd: config.budget.perStageUsd,
      });
      const confirmed = verdicts.filter((v) => v.verdict === 'CONFIRMED');
      const selfReview = {
        confirmed,
        plausible: verdicts.filter((v) => v.verdict === 'PLAUSIBLE'),
        refuted: verdicts.filter((v) => v.verdict === 'REFUTED').length,
        fixed: false,
      };
      if (confirmed.length) {
        const fix = await runner.runStage({
          label: 'self-review-fix',
          prompt: `Self-review confirmed these defects in the change you just made. Fix them minimally.\n\n${confirmed.map((f, i) => `${i + 1}. [${f.severity}] ${f.file}:${f.line} — ${f.summary}\n   ${f.verdictEvidence}`).join('\n')}`,
          model: opts.model ?? modelForRole(config, 'implement'),
          effort: opts.effort ?? effortForRole(config, 'implement'),
          permissionMode: 'acceptEdits',
          allowedTools: config.permissions.extraAllowedTools,
          maxBudgetUsd: config.budget.perStageUsd,
          resume: report.verify.sessionId ?? implementSessionId,
          cwd,
        });
        if (fix.ok) {
          const recheck = await runVerifyFixLoop(runner, { cwd, config, sessionId: fix.sessionId, maxRounds: 1, cmd: opts.cmd, onProgress: opts.onProgress });
          selfReview.fixed = recheck.pass;
          report.verify = recheck.pass ? recheck : report.verify;
          if (!recheck.pass) report.notes.push('self-review fix broke verification; the fix commit was left in place — inspect manually');
        } else {
          report.notes.push(`self-review fix session failed: ${fix.errorMessage ?? 'unknown'}`);
        }
      }
      report.selfReview = selfReview;
    } else if (!review) {
      report.notes.push('self-review produced no valid findings output');
    } else {
      report.selfReview = { confirmed: [], plausible: [], refuted: 0, fixed: false };
    }

    report.outcome = 'completed';
    return finish(report, runState, budget);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      report.outcome = 'budget-exhausted';
      report.notes.push(e.message);
      return finish(report, runState, budget);
    }
    throw e;
  }
}

function finish(report: SolveReport, runState: RunState, budget: Budget): SolveReport {
  report.costUsd = budget.spent();
  runState.finish({ outcome: report.outcome, costUsd: report.costUsd, notes: report.notes });
  return report;
}

export function registerSolve(program: Command, progress: (line: string) => void): void {
  program
    .command('solve')
    .description('full pipeline: explore → plan (skeptic-attacked) → implement → verify-fix loop → adversarial self-review')
    .argument('<task>', 'task description')
    .option('--plan-only', 'stop after printing the attacked plan')
    .option('--candidates <n>', 'independent solution candidates in parallel worktrees', (v: string) => parseInt(v, 10))
    .option('--judges <n>', 'judge panel seats (odd; default 3)', (v: string) => parseInt(v, 10))
    .option('--base <ref>', 'base ref for candidate worktrees', 'HEAD')
    .option('--keep-worktrees', 'keep candidate worktrees for inspection')
    .option('--yolo', 'bypassPermissions inside disposable candidate worktrees')
    .option('--max-rounds <n>', 'verify-fix round cap', (v: string) => parseInt(v, 10))
    .option('--budget <usd>', 'cost ceiling', parseFloat)
    .option('--model <model>', 'implement-stage model override')
    .option('--effort <level>', 'implement-stage effort override')
    .option('--cmd <command>', 'verify command override')
    .option('--json', 'machine-readable output')
    .action(async (task: string, opts: { planOnly?: boolean; candidates?: number; judges?: number; base?: string; keepWorktrees?: boolean; yolo?: boolean; maxRounds?: number; budget?: number; model?: string; effort?: string; cmd?: string; json?: boolean }) => {
      const report = await runSolve({
        task,
        planOnly: opts.planOnly,
        candidates: opts.candidates,
        judges: opts.judges,
        base: opts.base,
        keepWorktrees: opts.keepWorktrees,
        yolo: opts.yolo,
        maxRounds: opts.maxRounds,
        budgetUsd: opts.budget,
        model: opts.model,
        effort: opts.effort,
        cmd: opts.cmd,
        onProgress: opts.json ? undefined : progress,
      });
      if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      else process.stdout.write(renderSolveReport(report) + '\n');
      process.exitCode = report.outcome === 'completed' || report.outcome === 'plan-only' ? 0 : 1;
    });
}
