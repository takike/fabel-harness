import type { ClaudeRunner } from './claudeRunner.js';
import type { AgentDef } from './promptSource.js';
import { mapLimit, defaultConcurrency } from './parallel.js';
import { JudgeScoreSchema, JUDGE_JSON_SCHEMA, type JudgeScore } from '../report/schemas.js';

export interface JudgePanelContext {
  judge: AgentDef;
  cwd: string;
  model?: string;
  effort?: string;
  perStageUsd?: number;
  /** Extra rubric guidance appended to every judge prompt. */
  rubricNote?: string;
  /** Permission rules for dontAsk mode (read-only Bash allowlist etc.). */
  allowedTools?: string[];
}

export interface JudgePanelResult {
  winner: number;
  /** medianRank[candidate] — 1 is best. */
  medianRanks: number[];
  /** totals[seat][candidate]. */
  totals: number[][];
  seats: number;
  notes: string[];
}

const LABELS = 'ABCDEFGHIJ';

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function ranksFromTotals(totals: number[]): number[] {
  // rank 1 = highest total; ties share the better rank.
  const sorted = [...totals].map((t, i) => ({ t, i })).sort((a, b) => b.t - a.t);
  const ranks = new Array<number>(totals.length);
  sorted.forEach(({ i }, pos) => {
    ranks[i] = pos > 0 && sorted[pos - 1]!.t === sorted[pos]!.t ? ranks[sorted[pos - 1]!.i]! : pos + 1;
  });
  return ranks;
}

async function runSeat(
  runner: ClaudeRunner,
  candidateDiffs: readonly string[],
  ctx: JudgePanelContext,
  seat: number,
): Promise<number[]> {
  // Fresh anonymous labels and a fresh order per seat — labels/positions carry no info.
  const order = candidateDiffs.map((_, i) => i).sort(() => Math.random() - 0.5);
  const totals = new Array<number>(candidateDiffs.length).fill(0);
  await mapLimit(order, defaultConcurrency(), async (candidateIdx, pos) => {
    const label = LABELS[pos] ?? String(pos);
    const diff = candidateDiffs[candidateIdx]!;
    const structured = await runner.runStructured(
      {
        label: `judge:s${seat}:${label}`,
        prompt: [
          `Score candidate ${label} against the default rubric.${ctx.rubricNote ? ` ${ctx.rubricNote}` : ''}`,
          `Candidate ${label} diff:`,
          diff.trim() ? '```diff\n' + diff + '\n```' : '(empty diff — the candidate made no changes)',
        ].join('\n\n'),
        systemPrompt: ctx.judge.prompt,
        model: ctx.model,
        effort: ctx.effort,
        bare: true,
        tools: ctx.judge.tools,
        permissionMode: 'dontAsk',
        allowedTools: ctx.allowedTools,
        maxBudgetUsd: ctx.perStageUsd,
        jsonSchema: JUDGE_JSON_SCHEMA,
        cwd: ctx.cwd,
      },
      JudgeScoreSchema,
    );
    const value: JudgeScore | null = structured?.value ?? null;
    totals[candidateIdx] = value ? Object.values(value.scores).reduce((a, b) => a + b, 0) : 0;
  });
  return totals;
}

/**
 * Anonymized panel: `seats` independent judges each score every candidate in a
 * separate call; aggregate by median rank; ties get one extra seat, then fall back
 * to mean total, then lowest index.
 */
export async function runJudgePanel(
  runner: ClaudeRunner,
  candidateDiffs: readonly string[],
  ctx: JudgePanelContext,
  seats: number,
): Promise<JudgePanelResult> {
  const notes: string[] = [];
  if (seats % 2 === 0) {
    seats += 1;
    notes.push(`even judge count bumped to ${seats} (panels must be odd)`);
  }
  const totals: number[][] = [];
  for (let s = 0; s < seats; s++) totals.push(await runSeat(runner, candidateDiffs, ctx, s + 1));

  const computeWinner = (): { winner: number; medianRanks: number[]; tied: boolean } => {
    const ranksPerSeat = totals.map(ranksFromTotals);
    const medianRanks = candidateDiffs.map((_, c) => median(ranksPerSeat.map((r) => r[c]!)));
    const best = Math.min(...medianRanks);
    const winners = medianRanks.flatMap((r, i) => (r === best ? [i] : []));
    return { winner: winners[0]!, medianRanks, tied: winners.length > 1 };
  };

  let { winner, medianRanks, tied } = computeWinner();
  if (tied) {
    notes.push('median-rank tie — adding one extra judge seat');
    totals.push(await runSeat(runner, candidateDiffs, ctx, totals.length + 1));
    ({ winner, medianRanks, tied } = computeWinner());
    if (tied) {
      const means = candidateDiffs.map((_, c) => totals.reduce((acc, t) => acc + t[c]!, 0) / totals.length);
      const bestMean = Math.max(...means);
      winner = means.indexOf(bestMean);
      notes.push('still tied after extra seat — winner chosen by mean total');
    }
  }
  return { winner, medianRanks, totals, seats: totals.length, notes };
}
