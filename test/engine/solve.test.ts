import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runSolve } from '../../src/commands/solve.js';
import { renderSolveReport } from '../../src/report/render.js';

const FAKE = join(__dirname, '..', 'fixtures', 'fake-claude', 'claude');
const SOLVE = join(__dirname, '..', 'fixtures', 'solve');

const PASS_CMD = 'node -e "process.exit(0)"';
// Fails on the first run, passes afterwards (drives the verify-fix loop).
const FAIL_ONCE_CMD =
  'node -e "const fs=require(\'fs\'); if(!fs.existsSync(\'flag\')){fs.writeFileSync(\'flag\',\'\'); console.error(\'first run fails\'); process.exit(1)} process.exit(0)"';

function makeRepo(verifyCmd: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fabel-solve-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir });
  writeFileSync(join(dir, 'fabel.config.json'), JSON.stringify({ verify: { commands: [verifyCmd] } }));
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

describe('runSolve pipeline (offline, scripted claude)', () => {
  it('clean run: explore → plan (attack refuted) → implement → verify → clean self-review', async () => {
    process.env.FAKE_CLAUDE_MAP = join(SOLVE, 'map-clean.json');
    const dir = makeRepo(PASS_CMD);
    const report = await runSolve({ task: 'add a name argument to greet()', cwd: dir });

    expect(report.outcome).toBe('completed');
    expect(report.plan?.goal).toBe('greet() supports a name argument');
    expect(report.planAttack?.verdict).toBe('REFUTED');
    expect(report.verify?.pass).toBe(true);
    expect(report.verify?.rounds).toBe(1);
    expect(report.selfReview?.confirmed).toHaveLength(0);
    expect(report.implementSummary).toContain('Implemented per plan');

    const rendered = renderSolveReport(report);
    expect(rendered).toContain('Completed and verified');
    expect(rendered).toContain('0 confirmed, 0 plausible, 0 refuted');
  });

  it('attacked plan is revised; verify-fix loop and self-review fix both run', async () => {
    process.env.FAKE_CLAUDE_MAP = join(SOLVE, 'map-attacked.json');
    const argsDir = mkdtempSync(join(tmpdir(), 'fabel-solve-args-'));
    process.env.FAKE_CLAUDE_ARGS_DIR = argsDir;
    const dir = makeRepo(FAIL_ONCE_CMD);
    const report = await runSolve({ task: 'add a name argument to greet()', cwd: dir });

    expect(report.outcome).toBe('completed');
    // Plan was attacked (CONFIRMED) and revised.
    expect(report.planAttack?.verdict).toBe('CONFIRMED');
    expect(report.plan?.goal).toContain('without breaking locale callers');
    // Verify failed once, fix round ran, then passed.
    expect(report.verify?.pass).toBe(true);
    // Self-review found one defect, confirmed by skeptic, fixed, re-verified.
    expect(report.selfReview?.confirmed).toHaveLength(1);
    expect(report.selfReview?.fixed).toBe(true);

    // The fix round resumed the implement session.
    const calls = readdirSync(argsDir).map((f) => JSON.parse(readFileSync(join(argsDir, f), 'utf8')) as { argv: string[]; stdin: string });
    const fixCall = calls.find((c) => c.stdin.includes('The verification failed'));
    expect(fixCall).toBeDefined();
    const resumeIdx = fixCall!.argv.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(fixCall!.argv[resumeIdx + 1]).toBe('sess-impl');
    // Worker calls are bare; the implement call is not.
    const implementCall = calls.find((c) => c.stdin.includes('Implement the following task'));
    expect(implementCall!.argv).not.toContain('--bare');
    const explorerCall = calls.find((c) => c.stdin.includes('Your slice: the modules'));
    expect(explorerCall!.argv).toContain('--bare');
    expect(explorerCall!.argv).toContain('--tools');
  });

  it('--plan-only stops before implementing', async () => {
    process.env.FAKE_CLAUDE_MAP = join(SOLVE, 'map-clean.json');
    const dir = makeRepo(PASS_CMD);
    const report = await runSolve({ task: 'add a name argument to greet()', cwd: dir, planOnly: true });
    expect(report.outcome).toBe('plan-only');
    expect(report.implementSummary).toBe('');
    expect(report.verify).toBeNull();
    expect(renderSolveReport(report)).toContain('Plan ready');
  });

  it('budget exhaustion aborts cleanly with a partial report', async () => {
    process.env.FAKE_CLAUDE_MAP = join(SOLVE, 'map-clean.json');
    const dir = makeRepo(PASS_CMD);
    const report = await runSolve({ task: 'add a name argument to greet()', cwd: dir, budgetUsd: 0.02 });
    expect(report.outcome).toBe('budget-exhausted');
    expect(report.notes.join(' ')).toContain('budget exhausted');
  });

  it('failed verification after max rounds reports honestly', async () => {
    process.env.FAKE_CLAUDE_MAP = join(SOLVE, 'map-attacked.json');
    const dir = makeRepo('node -e "process.exit(1)"');
    const report = await runSolve({ task: 'add a name argument to greet()', cwd: dir, maxRounds: 2 });
    expect(report.outcome).toBe('failed-verification');
    expect(report.verify?.pass).toBe(false);
    expect(report.verify?.rounds).toBe(2);
    expect(renderSolveReport(report)).toContain('verification FAILED');
  });
});
