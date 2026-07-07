import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runSolve } from '../../src/commands/solve.js';

const FAKE = join(__dirname, '..', 'fixtures', 'fake-claude', 'claude');
const SOLVE = join(__dirname, '..', 'fixtures', 'solve');
const JUDGE_MAP_ENTRIES = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'judge', 'map.json'), 'utf8')) as unknown[];
const SOLVE_MAP_ENTRIES = JSON.parse(readFileSync(join(SOLVE, 'map-clean.json'), 'utf8')) as Array<{ matchAll: string[]; scenario: string }>;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fabel-cand-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'original\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir });
  writeFileSync(join(dir, 'fabel.config.json'), JSON.stringify({ verify: { commands: ['node -e "process.exit(0)"'] } }));
  return dir;
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['FABEL_CLAUDE_BIN', 'FAKE_CLAUDE_MAP', 'FAKE_CLAUDE_ARGS_DIR']) saved[k] = process.env[k];
  process.env.FABEL_CLAUDE_BIN = FAKE;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('multi-candidate solve (offline, scripted claude)', () => {
  it('creates worktrees, judges anonymized candidates, merges, and cleans up', async () => {
    const dir = makeRepo();
    // Solve fixtures for the pipeline stages + judge fixtures; candidate implement
    // sessions reuse the implement fixture (they make no real edits, so diffs are
    // empty and the panel ties → deterministic winner 0).
    const map = [
      ...SOLVE_MAP_ENTRIES.map((e) => ({ ...e, scenario: join(SOLVE, e.scenario) })),
      { matchAll: ['Your stance:'], scenario: join(SOLVE, 'implement.ndjson') },
      ...(JUDGE_MAP_ENTRIES as Array<{ matchAll: string[]; scenario: string }>).map((e) => ({
        ...e,
        scenario: join(__dirname, '..', 'fixtures', 'judge', e.scenario),
      })),
    ];
    const mapFile = join(mkdtempSync(join(tmpdir(), 'fabel-map-')), 'map.json');
    writeFileSync(mapFile, JSON.stringify(map));
    process.env.FAKE_CLAUDE_MAP = mapFile;
    const argsDir = mkdtempSync(join(tmpdir(), 'fabel-cand-args-'));
    process.env.FAKE_CLAUDE_ARGS_DIR = argsDir;

    const report = await runSolve({
      task: 'add a name argument to greet()',
      cwd: dir,
      candidates: 2,
      judges: 3,
    });

    expect(report.outcome).toBe('completed');
    expect(report.candidates).not.toBeNull();
    const c = report.candidates!;
    expect(c.perCandidate).toHaveLength(2);
    expect(c.perCandidate[0]!.angle).toBe('minimal-change');
    expect(c.perCandidate[1]!.angle).toBe('refactor-first');
    // No real edits → no commits → verify skipped, empty diffs tie the panel.
    expect(c.perCandidate.every((p) => p.verifyVerdict === 'SKIPPED')).toBe(true);
    expect(c.winnerIndex).toBe(0);
    expect(c.merged).toBe(true);
    expect(c.panel.seats).toBeGreaterThanOrEqual(3);

    // Worktrees cleaned up.
    expect(existsSync(join(dir, '.fabel', 'worktrees', report.runId, 'cand-0'))).toBe(false);
    const branches = execFileSync('git', ['branch', '--list', 'fabel/*'], { cwd: dir }).toString().trim();
    expect(branches).toBe('');

    // Candidate sessions ran inside their worktrees with differentiated stances.
    const calls = readdirSync(argsDir).map((f) => JSON.parse(readFileSync(join(argsDir, f), 'utf8')) as { stdin: string; cwd: string });
    const stanceCalls = calls.filter((call) => call.stdin.includes('Your stance:'));
    expect(stanceCalls).toHaveLength(2);
    expect(new Set(stanceCalls.map((call) => call.cwd)).size).toBe(2);
    expect(stanceCalls.some((call) => call.stdin.includes('SMALLEST diff'))).toBe(true);
    expect(stanceCalls.some((call) => call.stdin.includes('restructure the touched code'))).toBe(true);
    // Judges were called: 2 candidates × 3 seats (+ tie-break seat × 2).
    const judgeCalls = calls.filter((call) => call.stdin.includes('against the default rubric'));
    expect(judgeCalls.length).toBeGreaterThanOrEqual(6);
  }, 60_000);

  it('refuses to start on a dirty tree', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.txt'), 'dirty\n');
    process.env.FAKE_CLAUDE_MAP = join(SOLVE, 'map-clean.json');
    await expect(runSolve({ task: 'x', cwd: dir, candidates: 2 })).rejects.toThrow(/uncommitted changes/);
  });
});
