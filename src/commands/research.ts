import type { Command } from 'commander';
import { loadConfig, modelForRole, effortForRole, workerAllowedTools } from '../config.js';
import { ClaudeRunner } from '../engine/claudeRunner.js';
import { Budget, BudgetExceededError } from '../engine/budget.js';
import { RunState } from '../engine/runState.js';
import { defaultPluginDir, loadAgent, loadSkillBody } from '../engine/promptSource.js';
import { mapLimit, defaultConcurrency } from '../engine/parallel.js';
import {
  DecomposeSchema,
  DECOMPOSE_JSON_SCHEMA,
  ResearchAnswerSchema,
  RESEARCH_JSON_SCHEMA,
  VerdictSchema,
  VERDICT_JSON_SCHEMA,
  type ResearchAnswer,
  type Verdict,
} from '../report/schemas.js';
import { renderResearchReport } from '../report/render.js';

export interface ResearchOptions {
  question: string;
  cwd?: string;
  /** Max sub-questions for the sweep (default 4). */
  sweep?: number;
  budgetUsd?: number;
  onProgress?: (line: string) => void;
}

export interface ResearchReport {
  question: string;
  answer: ResearchAnswer | null;
  subQuestions: string[];
  attacks: Array<{ claim: string; verdict: Verdict['verdict']; evidence: string }>;
  costUsd: number;
  runId: string;
  notes: string[];
}

export async function runResearch(opts: ResearchOptions): Promise<ResearchReport> {
  const cwd = opts.cwd ?? process.cwd();
  const config = loadConfig(cwd);
  const pluginDir = defaultPluginDir();
  const explorer = loadAgent(pluginDir, 'explorer');
  const researcher = loadAgent(pluginDir, 'researcher');
  const skeptic = loadAgent(pluginDir, 'skeptic');
  const doctrine = loadSkillBody(pluginDir, 'doctrine');

  const budget = new Budget(opts.budgetUsd ?? config.budget.defaultUsd);
  const runState = RunState.create(cwd, 'research', { question: opts.question });
  const runner = new ClaudeRunner({ budget, runState, onProgress: opts.onProgress });

  const report: ResearchReport = {
    question: opts.question,
    answer: null,
    subQuestions: [],
    attacks: [],
    costUsd: 0,
    runId: runState.id,
    notes: [],
  };

  try {
    // 1. Decompose into sub-questions.
    const maxSweep = Math.max(1, Math.min(opts.sweep ?? 4, 5));
    const decomposed = await runner.runStructured(
      {
        label: 'decompose',
        prompt: `Decompose this research question about the codebase in ${cwd} into 2-${maxSweep} independent sub-questions that together answer it. Sub-questions must be answerable by reading code.\n\nQuestion: ${opts.question}`,
        systemPrompt: doctrine,
        model: modelForRole(config, 'planner'),
        effort: effortForRole(config, 'planner'),
        bare: true,
        tools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'dontAsk',
        allowedTools: workerAllowedTools(config),
        maxBudgetUsd: config.budget.perStageUsd,
        jsonSchema: DECOMPOSE_JSON_SCHEMA,
        cwd,
      },
      DecomposeSchema,
    );
    const subQuestions = (decomposed?.value.sub_questions ?? [opts.question]).slice(0, maxSweep);
    if (!decomposed) report.notes.push('decomposition failed — researching the question as a single slice');
    report.subQuestions = subQuestions;

    // 2. Sweep — explorers locate the territory per sub-question.
    const maps = await mapLimit(subQuestions, defaultConcurrency(), async (sq, i) => {
      const r = await runner.runStage({
        label: `sweep:${i + 1}`,
        prompt: `Parent research question: ${opts.question}\n\nYour slice: LOCATE the code/docs relevant to this sub-question (map only, do not answer it): ${sq}`,
        systemPrompt: explorer.prompt,
        model: modelForRole(config, 'explorer'),
        effort: effortForRole(config, 'explorer'),
        bare: true,
        tools: explorer.tools,
        permissionMode: 'dontAsk',
        allowedTools: workerAllowedTools(config),
        maxBudgetUsd: config.budget.perStageUsd,
        cwd,
      });
      return r.ok ? r.resultText : `(sweep failed: ${r.errorMessage})`;
    });

    // 3. Deep-read — researchers answer their sub-question with citations.
    const answers = await mapLimit(subQuestions, defaultConcurrency(), async (sq, i) => {
      const structured = await runner.runStructured(
        {
          label: `deep-read:${i + 1}`,
          prompt: `Sub-question: ${sq}\n\nAssigned territory (from an explorer sweep):\n${maps[i]}\n\nAnswer the sub-question only, with [observed]/[inferred] tagging and file:line citations.`,
          systemPrompt: researcher.prompt,
          model: modelForRole(config, 'researcher'),
          effort: effortForRole(config, 'researcher'),
          bare: true,
          tools: researcher.tools,
          permissionMode: 'dontAsk',
          allowedTools: workerAllowedTools(config),
          maxBudgetUsd: config.budget.perStageUsd,
          jsonSchema: RESEARCH_JSON_SCHEMA,
          cwd,
        },
        ResearchAnswerSchema,
      );
      return { sq, answer: structured?.value ?? null };
    });
    const failed = answers.filter((a) => !a.answer).length;
    if (failed) report.notes.push(`${failed} deep-read call(s) produced no valid answer`);

    // 4. Synthesize into one cited answer.
    const synthesis = await runner.runStructured(
      {
        label: 'synthesize',
        prompt: [
          `Synthesize ONE answer to the research question from the sub-answers below. Preserve citations; resolve contradictions by reading the disputed code yourself, never by majority.`,
          `Question: ${opts.question}`,
          ...answers.map((a, i) => `## Sub-question ${i + 1}: ${a.sq}\n${a.answer ? JSON.stringify(a.answer, null, 2) : '(no valid answer)'}`),
        ].join('\n\n'),
        systemPrompt: `${researcher.prompt}\n\n---\n\n${doctrine}`,
        model: modelForRole(config, 'planner'),
        effort: effortForRole(config, 'planner'),
        bare: true,
        tools: researcher.tools,
        permissionMode: 'dontAsk',
        allowedTools: workerAllowedTools(config),
        maxBudgetUsd: config.budget.perStageUsd,
        jsonSchema: RESEARCH_JSON_SCHEMA,
        cwd,
      },
      ResearchAnswerSchema,
    );
    if (!synthesis) {
      report.notes.push('synthesis failed');
      return finish(report, runState, budget);
    }
    report.answer = synthesis.value;

    // 5. Attack the load-bearing claims (up to 3, observed first).
    const loadBearing = [...synthesis.value.evidence].sort((a, b) => (a.kind === 'observed' ? -1 : 1) - (b.kind === 'observed' ? -1 : 1)).slice(0, 3);
    const attacks = await mapLimit(loadBearing, defaultConcurrency(), async (ev) => {
      const structured = await runner.runStructured(
        {
          label: `attack:${ev.citation.slice(0, 30)}`,
          prompt: `Attempt to refute this research claim by reading the cited code.\n\nClaim: ${ev.claim}\nCitation: ${ev.citation}\n\nCONFIRMED = the claim holds (cite the code); REFUTED = the claim is wrong (cite why); PLAUSIBLE = cannot decide.`,
          systemPrompt: skeptic.prompt,
          model: modelForRole(config, 'skeptic'),
          effort: effortForRole(config, 'skeptic'),
          bare: true,
          tools: skeptic.tools,
          permissionMode: 'dontAsk',
          allowedTools: workerAllowedTools(config),
          maxBudgetUsd: config.budget.perStageUsd,
          jsonSchema: VERDICT_JSON_SCHEMA,
          cwd,
        },
        VerdictSchema,
      );
      return {
        claim: ev.claim,
        verdict: structured?.value.verdict ?? ('PLAUSIBLE' as const),
        evidence: structured?.value.evidence ?? 'attack call failed; claim unverified',
      };
    });
    report.attacks = attacks;
    const refuted = attacks.filter((a) => a.verdict === 'REFUTED');
    if (refuted.length) {
      report.notes.push(`${refuted.length} load-bearing claim(s) REFUTED — treat the answer with caution and re-run after refining the question`);
    }
    return finish(report, runState, budget);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      report.notes.push(e.message);
      return finish(report, runState, budget);
    }
    throw e;
  }
}

function finish(report: ResearchReport, runState: RunState, budget: Budget): ResearchReport {
  report.costUsd = budget.spent();
  runState.finish({ answered: Boolean(report.answer), costUsd: report.costUsd });
  return report;
}

export function registerResearch(program: Command, progress: (line: string) => void): void {
  program
    .command('research')
    .description('sweep → deep-read → cited synthesis → skeptic attack on load-bearing claims')
    .argument('<question>', 'research question about the codebase')
    .option('--sweep <n>', 'max sub-questions (default 4, cap 5)', (v: string) => parseInt(v, 10))
    .option('--budget <usd>', 'cost ceiling', parseFloat)
    .option('--json', 'machine-readable output')
    .action(async (question: string, opts: { sweep?: number; budget?: number; json?: boolean }) => {
      const report = await runResearch({
        question,
        sweep: opts.sweep,
        budgetUsd: opts.budget,
        onProgress: opts.json ? undefined : progress,
      });
      if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      else process.stdout.write(renderResearchReport(report) + '\n');
      process.exitCode = report.answer ? 0 : 1;
    });
}
