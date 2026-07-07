import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRunner } from '../../src/engine/claudeRunner.js';
import { Budget, BudgetExceededError } from '../../src/engine/budget.js';
import { RunState } from '../../src/engine/runState.js';
import { VerdictSchema } from '../../src/report/schemas.js';

const FAKE = join(__dirname, '..', 'fixtures', 'fake-claude', 'claude');
const STREAMS = join(__dirname, '..', 'fixtures', 'streams');

function scenarioEnv(name: string): Record<string, string> {
  return { FAKE_CLAUDE_SCENARIO: join(STREAMS, name) };
}

describe('ClaudeRunner.buildArgs', () => {
  const runner = new ClaudeRunner({ claudeBin: FAKE });

  it('always emits headless stream-json flags', () => {
    expect(runner.buildArgs({ label: 'x', prompt: 'p' })).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
  });

  it('maps stage options to claude flags', () => {
    const args = runner.buildArgs({
      label: 'x',
      prompt: 'p',
      bare: true,
      model: 'opus',
      effort: 'high',
      maxTurns: 12,
      maxBudgetUsd: 2.5,
      permissionMode: 'dontAsk',
      tools: ['Read', 'Grep'],
      allowedTools: ['Bash(npm test:*)'],
      agentsJson: '{"a":{}}',
      systemPrompt: 'persona',
      jsonSchema: { type: 'object' },
      resume: 'sess-9',
    });
    expect(args).toContain('--bare');
    expect(args.join(' ')).toContain('--model opus');
    expect(args.join(' ')).toContain('--effort high');
    expect(args.join(' ')).toContain('--max-turns 12');
    expect(args.join(' ')).toContain('--max-budget-usd 2.5');
    expect(args.join(' ')).toContain('--permission-mode dontAsk');
    expect(args.join(' ')).toContain('--tools Read,Grep');
    expect(args).toContain('Bash(npm test:*)');
    expect(args.join(' ')).toContain('--resume sess-9');
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
  });
});

describe('ClaudeRunner.runStage', () => {
  it('parses a successful stream (text, session, cost, turns)', async () => {
    const runner = new ClaudeRunner({ claudeBin: FAKE });
    const r = await runner.runStage({ label: 'ok', prompt: 'hi', env: scenarioEnv('success-simple.ndjson') });
    expect(r.ok).toBe(true);
    expect(r.resultText).toBe('All done. The answer is 42.');
    expect(r.sessionId).toBe('sess-001');
    expect(r.costUsd).toBeCloseTo(0.0123);
    expect(r.numTurns).toBe(3);
    expect(r.exitCode).toBe(0);
  });

  it('passes the prompt via stdin and records argv', async () => {
    const argsDir = mkdtempSync(join(tmpdir(), 'fabel-args-'));
    const runner = new ClaudeRunner({ claudeBin: FAKE });
    await runner.runStage({
      label: 'ok',
      prompt: 'the actual prompt text',
      model: 'sonnet',
      env: { ...scenarioEnv('success-simple.ndjson'), FAKE_CLAUDE_ARGS_DIR: argsDir },
    });
    const calls = readdirSync(argsDir);
    expect(calls).toHaveLength(1);
    const call = JSON.parse(readFileSync(join(argsDir, calls[0]!), 'utf8'));
    expect(call.stdin).toBe('the actual prompt text');
    expect(call.argv).toContain('--model');
  });

  it('tolerates malformed and unknown lines', async () => {
    const runner = new ClaudeRunner({ claudeBin: FAKE });
    const r = await runner.runStage({ label: 'mal', prompt: 'hi', env: scenarioEnv('malformed.ndjson') });
    expect(r.ok).toBe(true);
    expect(r.resultText).toBe('survived malformed lines');
    expect(r.malformedLines).toBe(1);
  });

  it('reports error results as not ok', async () => {
    const runner = new ClaudeRunner({ claudeBin: FAKE });
    const r = await runner.runStage({ label: 'err', prompt: 'hi', env: scenarioEnv('error-result.ndjson') });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain('Execution failed');
    expect(r.costUsd).toBeCloseTo(0.001);
  });

  it('reports nonzero exit without result as not ok', async () => {
    const runner = new ClaudeRunner({ claudeBin: FAKE });
    const r = await runner.runStage({ label: 'dead', prompt: 'hi', env: scenarioEnv('exit-nonzero.ndjson') });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.errorMessage).toContain('without a result event');
  });

  it('reports a missing binary as not ok without throwing', async () => {
    const runner = new ClaudeRunner({ claudeBin: '/nonexistent/claude-nope' });
    const r = await runner.runStage({ label: 'none', prompt: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe('claude binary not found');
  });
});

describe('ClaudeRunner.runStructured', () => {
  it('returns validated structured output', async () => {
    const runner = new ClaudeRunner({ claudeBin: FAKE });
    const out = await runner.runStructured(
      { label: 'skeptic', prompt: 'refute this', env: scenarioEnv('success-refuted.ndjson') },
      VerdictSchema,
    );
    expect(out).not.toBeNull();
    expect(out!.value.verdict).toBe('REFUTED');
  });

  it('retries once on schema mismatch, then succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabel-queue-'));
    cpSync(join(STREAMS, 'invalid-structured.ndjson'), join(dir, '001-bad.ndjson'));
    cpSync(join(STREAMS, 'success-confirmed.ndjson'), join(dir, '002-good.ndjson'));
    const runner = new ClaudeRunner({ claudeBin: FAKE });
    const out = await runner.runStructured(
      { label: 'skeptic', prompt: 'refute this', env: { FAKE_CLAUDE_DIR: dir } },
      VerdictSchema,
    );
    expect(out).not.toBeNull();
    expect(out!.value.verdict).toBe('CONFIRMED');
  });

  it('drops after two invalid outputs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabel-queue-'));
    cpSync(join(STREAMS, 'invalid-structured.ndjson'), join(dir, '001-bad.ndjson'));
    cpSync(join(STREAMS, 'invalid-structured.ndjson'), join(dir, '002-bad.ndjson'));
    const runner = new ClaudeRunner({ claudeBin: FAKE });
    const out = await runner.runStructured(
      { label: 'skeptic', prompt: 'refute this', env: { FAKE_CLAUDE_DIR: dir } },
      VerdictSchema,
    );
    expect(out).toBeNull();
  });
});

describe('budget and run state integration', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fabel-run-'));
  });

  it('stops scheduling stages once the budget is exhausted', async () => {
    const budget = new Budget(1.0);
    const runner = new ClaudeRunner({ claudeBin: FAKE, budget });
    const first = await runner.runStage({ label: 'exp', prompt: 'hi', env: scenarioEnv('expensive.ndjson') });
    expect(first.ok).toBe(true);
    expect(budget.spent()).toBeCloseTo(5.0);
    await expect(runner.runStage({ label: 'next', prompt: 'hi', env: scenarioEnv('success-simple.ndjson') })).rejects.toThrow(
      BudgetExceededError,
    );
  });

  it('records stages and raw transcripts in run state', async () => {
    const runState = RunState.create(root, 'test-run');
    const runner = new ClaudeRunner({ claudeBin: FAKE, runState });
    await runner.runStage({ label: 'stage one', prompt: 'hi', env: scenarioEnv('success-simple.ndjson') });
    await runner.runStage({ label: 'stage two', prompt: 'hi', env: scenarioEnv('error-result.ndjson') });

    const reloaded = RunState.load(root, runState.id);
    expect(reloaded.stages).toHaveLength(2);
    expect(reloaded.stages[0]!.ok).toBe(true);
    expect(reloaded.stages[0]!.sessionId).toBe('sess-001');
    expect(reloaded.stages[1]!.ok).toBe(false);
    expect(reloaded.totalCost()).toBeCloseTo(0.0123 + 0.001);
    expect(existsSync(runState.eventFile(1, 'stage one'))).toBe(true);
    const raw = readFileSync(runState.eventFile(1, 'stage one'), 'utf8').trim().split('\n');
    expect(raw.length).toBe(3);
  });
});
