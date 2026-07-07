import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runReview } from '../../src/commands/review.js';
import { loopUntilDry } from '../../src/engine/loopUntilDry.js';
import { isDuplicate, dedupeNew } from '../../src/engine/findings.js';
import type { Finding } from '../../src/report/schemas.js';
import { renderReviewReport } from '../../src/report/render.js';

const FAKE = join(__dirname, '..', 'fixtures', 'fake-claude', 'claude');
const MAP = join(__dirname, '..', 'fixtures', 'review', 'map.json');

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fabel-review-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.FABEL_CLAUDE_BIN = process.env.FABEL_CLAUDE_BIN;
  saved.FAKE_CLAUDE_MAP = process.env.FAKE_CLAUDE_MAP;
  process.env.FABEL_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_MAP = MAP;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('loopUntilDry', () => {
  it('stops after K consecutive dry rounds', async () => {
    const yields = [[1], [], [2], [], []];
    const { items, rounds, hitCap } = await loopUntilDry(async (r) => yields[r - 1] ?? [], { dryRounds: 2, maxRounds: 10 });
    expect(items).toEqual([1, 2]);
    expect(rounds).toBe(5);
    expect(hitCap).toBe(false);
  });

  it('hits the cap while still productive', async () => {
    const { rounds, hitCap } = await loopUntilDry(async () => [1], { dryRounds: 2, maxRounds: 3 });
    expect(rounds).toBe(3);
    expect(hitCap).toBe(true);
  });
});

describe('finding dedupe', () => {
  const base: Finding = {
    summary: 'Off-by-one in pagination limit slicing',
    file: 'src/page.ts',
    line: 42,
    failure_scenario: 'x',
    severity: 'major',
    confidence: 'high',
  };

  it('detects near-duplicates by file+line+summary similarity', () => {
    expect(isDuplicate(base, { ...base, line: 43, summary: 'Off-by-one pagination limit boundary untested' })).toBe(true);
    expect(isDuplicate(base, { ...base, file: 'src/other.ts' })).toBe(false);
    expect(isDuplicate(base, { ...base, line: 400, summary: 'Missing null check on user input' })).toBe(false);
  });

  it('dedupes within a batch keeping the higher severity', () => {
    const fresh = dedupeNew(
      [
        { ...base, severity: 'minor' },
        { ...base, line: 44, severity: 'critical' },
      ],
      [],
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.severity).toBe('critical');
  });
});

describe('runReview pipeline (offline, scripted claude)', () => {
  it('finds, dedupes, verifies, and terminates dry', async () => {
    const dir = makeRepo();
    const report = await runReview({ cwd: dir, lenses: ['correctness', 'tests'], dryRounds: 2, maxRounds: 4 });

    // Round 1: 2 findings from correctness + 1 dup from tests → 2 fresh.
    // Skeptics: off-by-one CONFIRMED, SQL injection REFUTED.
    // Rounds 2-3: empty → dry termination.
    expect(report.confirmed).toHaveLength(1);
    expect(report.confirmed[0]!.summary).toContain('Off-by-one');
    expect(report.confirmed[0]!.verdict).toBe('CONFIRMED');
    expect(report.refuted).toBe(1);
    expect(report.plausible).toHaveLength(0);
    expect(report.rounds).toBe(3);
    expect(report.hitCap).toBe(false);
    expect(report.budgetExhausted).toBe(false);
    // 2 lenses × 3 rounds reviewers + 2 skeptics = 8 calls of known cost.
    expect(report.costUsd).toBeCloseTo(0.05 + 0.04 + 0.06 + 0.05 + 4 * 0.03, 5);

    const rendered = renderReviewReport(report);
    expect(rendered).toContain('1 confirmed, 0 plausible, 1 refuted');
    expect(rendered).toContain('[major] src/page.ts:42');
    expect(rendered).not.toContain('SQL injection');
  });

  it('stops early and reports partial coverage when the budget runs out', async () => {
    const dir = makeRepo();
    const report = await runReview({ cwd: dir, lenses: ['correctness', 'tests'], budgetUsd: 0.08 });
    expect(report.budgetExhausted).toBe(true);
    expect(report.notes.join(' ')).toContain('budget exhausted');
    expect(renderReviewReport(report)).toContain('partial result');
  });

  it('--fix applies confirmed fixes and re-verifies', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'fabel.config.json'), JSON.stringify({ verify: { commands: ['node -e "process.exit(0)"'] } }));
    const report = await runReview({ cwd: dir, lenses: ['correctness', 'tests'], fix: true });
    expect(report.fix?.applied).toBe(true);
    expect(report.fix?.detail).toContain('Fixed the off-by-one');
    expect(report.fix?.verify?.verdict).toBe('PASS');
  });
});
