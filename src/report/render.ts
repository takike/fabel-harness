import { sortBySeverity } from '../engine/findings.js';
import type { VerifiedFinding } from '../engine/skepticPool.js';
import type { ReviewReport } from '../commands/review.js';

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
