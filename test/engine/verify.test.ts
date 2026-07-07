import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectVerifyCommands, runVerify, treeStateHash } from '../../src/commands/verify.js';
import { loadConfig } from '../../src/config.js';

const FAKE = join(__dirname, '..', 'fixtures', 'fake-claude', 'claude');
const STREAMS = join(__dirname, '..', 'fixtures', 'streams');

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fabel-verify-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv.FABEL_CLAUDE_BIN = process.env.FABEL_CLAUDE_BIN;
  savedEnv.FAKE_CLAUDE_SCENARIO = process.env.FAKE_CLAUDE_SCENARIO;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('detectVerifyCommands', () => {
  it('prefers override, then config, then auto-detection', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x', build: 'y' } }));
    const cfg = loadConfig(dir);
    expect(detectVerifyCommands(dir, cfg, 'go test ./...')).toEqual(['go test ./...']);
    expect(detectVerifyCommands(dir, cfg)).toEqual(['npm test', 'npm run build']);

    writeFileSync(join(dir, 'fabel.config.json'), JSON.stringify({ verify: { commands: ['make check'] } }));
    expect(detectVerifyCommands(dir, loadConfig(dir))).toEqual(['make check']);
  });

  it('detects Makefile and pyproject fallbacks', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'Makefile'), 'test:\n\ttrue\n');
    expect(detectVerifyCommands(dir, loadConfig(dir))).toEqual(['make test']);
  });
});

describe('runVerify (deterministic layer)', () => {
  it('PASS when all commands exit 0, and writes the marker', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'fabel.config.json'), JSON.stringify({ verify: { commands: ['node -e "process.exit(0)"'] } }));
    const report = await runVerify({ cwd: dir });
    expect(report.verdict).toBe('PASS');
    expect(report.markerWritten).toBe(true);
    const marker = readFileSync(join(dir, '.fabel', 'verified'), 'utf8').trim();
    expect(marker).toBe(treeStateHash(dir));
  });

  it('FAIL when a command exits nonzero; no marker; exit output captured', async () => {
    const dir = makeRepo();
    writeFileSync(
      join(dir, 'fabel.config.json'),
      JSON.stringify({ verify: { commands: ['node -e "console.error(\'boom\'); process.exit(1)"'] } }),
    );
    const report = await runVerify({ cwd: dir });
    expect(report.verdict).toBe('FAIL');
    expect(report.markerWritten).toBe(false);
    expect(existsSync(join(dir, '.fabel', 'verified'))).toBe(false);
    expect(report.commands[0]!.outputTail).toContain('boom');
  });

  it('PARTIAL when nothing is configured or detected', async () => {
    const dir = makeRepo();
    const report = await runVerify({ cwd: dir });
    expect(report.verdict).toBe('PARTIAL');
    expect(report.notes.join(' ')).toContain('no verify commands');
  });
});

describe('runVerify --e2e (agent layer via fake claude)', () => {
  it('agent PASS + commands PASS → PASS', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'fabel.config.json'), JSON.stringify({ verify: { commands: ['node -e "process.exit(0)"'] } }));
    process.env.FABEL_CLAUDE_BIN = FAKE;
    process.env.FAKE_CLAUDE_SCENARIO = join(STREAMS, 'verify-pass.ndjson');
    const report = await runVerify({ cwd: dir, e2e: true });
    expect(report.verdict).toBe('PASS');
    expect(report.agent?.verdict).toBe('PASS');
    expect(report.costUsd).toBeCloseTo(0.04);
  });

  it('agent can downgrade a command PASS to PARTIAL, never upgrade a FAIL', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'fabel.config.json'), JSON.stringify({ verify: { commands: ['node -e "process.exit(0)"'] } }));
    process.env.FABEL_CLAUDE_BIN = FAKE;
    process.env.FAKE_CLAUDE_SCENARIO = join(STREAMS, 'verify-partial.ndjson');
    const downgraded = await runVerify({ cwd: dir, e2e: true });
    expect(downgraded.verdict).toBe('PARTIAL');
    expect(downgraded.markerWritten).toBe(false);

    writeFileSync(join(dir, 'fabel.config.json'), JSON.stringify({ verify: { commands: ['node -e "process.exit(1)"'] } }));
    process.env.FAKE_CLAUDE_SCENARIO = join(STREAMS, 'verify-pass.ndjson');
    const failed = await runVerify({ cwd: dir, e2e: true });
    expect(failed.verdict).toBe('FAIL');
  });

  it('agent verdict decides when no commands exist', async () => {
    const dir = makeRepo();
    process.env.FABEL_CLAUDE_BIN = FAKE;
    process.env.FAKE_CLAUDE_SCENARIO = join(STREAMS, 'verify-pass.ndjson');
    const report = await runVerify({ cwd: dir, e2e: true });
    expect(report.verdict).toBe('PASS');
  });
});
