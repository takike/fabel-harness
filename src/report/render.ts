import { sortBySeverity } from '../engine/findings.js';
import type { VerifiedFinding } from '../engine/skepticPool.js';
import type { ReviewReport } from '../commands/review.js';
import type { SolveReport } from '../commands/solve.js';
import type { ResearchReport } from '../commands/research.js';

/** Lead-with-outcome markdown reports. */

function renderFinding(f: VerifiedFinding): string {
  return [
    `### [${f.severity}] ${f.file}:${f.line} — ${f.summary}`,
    f.lens ? `lens: ${f.lens} · reviewer confidence: ${f.confidence}` : `reviewer confidence: ${f.confidence}`,
    `**Failure scenario**: ${f.failure_scenario}`,
    `**Verification**: ${f.verdict} — ${f.verdictEvidence}`,
  ].join('\n');
}

export function renderReviewReport(r: ReviewReport): string {
  const lines: string[] = [];
  lines.push(
    `## Review: ${r.confirmed.length} confirmed, ${r.plausible.length} plausible, ${r.refuted} refuted (${r.rounds} rounds, $${r.costUsd.toFixed(2)})`,
  );
  if (r.hitCap) lines.push('', '⚠ round cap hit while findings were still arriving — coverage may be incomplete.');
  if (r.budgetExhausted) lines.push('', '⚠ budget exhausted — this is a partial result.');
  if (r.confirmed.length) {
    lines.push('', '## Confirmed');
    for (const f of sortBySeverity(r.confirmed)) lines.push('', renderFinding(f));
  }
  if (r.plausible.length) {
    lines.push('', '## Plausible (could not be refuted or proven)');
    for (const f of sortBySeverity(r.plausible)) lines.push('', renderFinding(f));
  }
  if (!r.confirmed.length && !r.plausible.length) {
    lines.push('', 'No findings survived adversarial verification.');
  }
  if (r.fix) {
    lines.push('', '## Fixes');
    lines.push(r.fix.applied ? `applied — ${r.fix.detail}` : r.fix.detail);
    if (r.fix.verify) lines.push(`re-verify: ${r.fix.verify.verdict}`);
  }
  for (const n of r.notes) lines.push('', `note: ${n}`);
  lines.push('', `run: .fabel/runs/${r.runId}`);
  return lines.join('\n');
}

export function renderResearchReport(r: ResearchReport): string {
  const lines: string[] = [];
  if (!r.answer) {
    lines.push(`## Research incomplete — ${r.question} ($${r.costUsd.toFixed(2)})`);
  } else {
    lines.push(`## ${r.answer.answer.split('\n')[0]}`, '', r.answer.answer, '', '## Evidence');
    for (const e of r.answer.evidence) {
      const attack = r.attacks.find((a) => a.claim === e.claim);
      lines.push(`- [${e.kind}] ${e.claim} (${e.citation})${attack ? ` — skeptic: ${attack.verdict}` : ''}`);
    }
    const refuted = r.attacks.filter((a) => a.verdict === 'REFUTED');
    if (refuted.length) {
      lines.push('', '## Refuted claims (answer weakened)');
      for (const a of refuted) lines.push(`- ${a.claim} — ${a.evidence}`);
    }
    if (r.answer.gaps.length) {
      lines.push('', '## Gaps');
      for (const g of r.answer.gaps) lines.push(`- ${g}`);
    }
  }
  for (const n of r.notes) lines.push('', `note: ${n}`);
  lines.push('', `cost: $${r.costUsd.toFixed(2)} · run: .fabel/runs/${r.runId}`);
  return lines.join('\n');
}

const SOLVE_HEADLINES: Record<SolveReport['outcome'], string> = {
  completed: 'Completed and verified',
  'plan-only': 'Plan ready (not implemented)',
  'failed-verification': 'Implemented but verification FAILED',
  'budget-exhausted': 'Stopped: budget exhausted',
  error: 'Stopped before completion',
};

export function renderSolveReport(r: SolveReport): string {
  const lines: string[] = [];
  lines.push(`## ${SOLVE_HEADLINES[r.outcome]} — ${r.task} ($${r.costUsd.toFixed(2)})`);

  if (r.candidates) {
    lines.push(
      '',
      `**Candidates**: winner ${r.candidates.winnerIndex} (${r.candidates.winnerAngle}) from ${r.candidates.perCandidate.length}, judged by ${r.candidates.panel.seats} seats — median ranks [${r.candidates.panel.medianRanks.join(', ')}]${r.candidates.merged ? '' : ' — MERGE FAILED'}`,
    );
    r.candidates.perCandidate.forEach((c, i) =>
      lines.push(`- ${i}: ${c.angle} — ${c.implemented ? 'implemented' : 'FAILED'}${c.committed ? '' : ' (no changes)'}, verify ${c.verifyVerdict}`),
    );
  }

  if (r.verify?.last) {
    lines.push('', `**Verification**: ${r.verify.last.verdict} after ${r.verify.rounds} round(s)`);
    for (const c of r.verify.last.commands) lines.push(`- \`${c.command}\` → exit ${c.exitCode}`);
  }
  if (r.selfReview) {
    const s = r.selfReview;
    lines.push(
      '',
      `**Self-review**: ${s.confirmed.length} confirmed, ${s.plausible.length} plausible, ${s.refuted} refuted${s.confirmed.length ? (s.fixed ? ' — confirmed issues fixed and re-verified' : ' — fixes NOT re-verified') : ''}`,
    );
    for (const f of sortBySeverity(s.plausible)) lines.push('', renderFinding(f));
  }
  if (r.implementSummary) lines.push('', '**Implementer summary**:', r.implementSummary.slice(0, 1500));
  if (r.plan && (r.outcome === 'plan-only' || r.outcome === 'error')) {
    lines.push('', '**Plan**:', `Goal: ${r.plan.goal}`, ...r.plan.steps.map((s, i) => `${i + 1}. ${s}`));
    if (r.planAttack) lines.push('', `Plan attack: ${r.planAttack.verdict} — ${r.planAttack.evidence}`);
  }
  for (const n of r.notes) lines.push('', `note: ${n}`);
  lines.push('', `run: .fabel/runs/${r.runId}`);
  return lines.join('\n');
}
