import type { Finding } from '../report/schemas.js';

/**
 * Dedupe rules from the verification-protocol skill: same file + overlapping line
 * range (±3) + similar summary, or near-identical summaries in the same file.
 * Dedupe runs against ALL previously seen findings (including refuted ones) so dead
 * findings cannot resurrect in later rounds.
 */

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export function isDuplicate(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;
  const sim = jaccard(words(a.summary), words(b.summary));
  const lineClose = Math.abs((a.line ?? 0) - (b.line ?? 0)) <= 3;
  return (lineClose && sim >= 0.3) || sim >= 0.7;
}

const SEVERITY_RANK: Record<Finding['severity'], number> = { critical: 0, major: 1, minor: 2 };

/** Filter `incoming` down to findings not already in `seen` (nor duplicated within the batch). */
export function dedupeNew(incoming: readonly Finding[], seen: readonly Finding[]): Finding[] {
  const fresh: Finding[] = [];
  for (const f of incoming) {
    if (seen.some((s) => isDuplicate(f, s))) continue;
    const twin = fresh.find((s) => isDuplicate(f, s));
    if (twin) {
      // Keep the higher-severity phrasing of an in-batch duplicate.
      if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[twin.severity]) fresh[fresh.indexOf(twin)] = f;
      continue;
    }
    fresh.push(f);
  }
  return fresh;
}

export function sortBySeverity<T extends Finding>(findings: readonly T[]): T[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.file.localeCompare(b.file));
}
