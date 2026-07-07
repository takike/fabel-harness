import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, modelForRole, effortForRole } from '../../src/config.js';
import { Budget } from '../../src/engine/budget.js';

describe('config', () => {
  it('returns defaults when no file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabel-cfg-'));
    const cfg = loadConfig(dir);
    expect(cfg.review.lenses).toEqual(['correctness', 'security', 'concurrency', 'tests']);
    expect(cfg.review.dryRounds).toBe(2);
    expect(cfg.review.maxRounds).toBe(4);
    expect(cfg.verify.timeoutSec).toBe(600);
    expect(modelForRole(cfg, 'explorer')).toBe('sonnet');
    expect(modelForRole(cfg, 'skeptic')).toBe('opus');
    expect(effortForRole(cfg, 'implement')).toBe('xhigh');
    expect(effortForRole(cfg, 'skeptic')).toBe('high');
  });

  it('merges a config file over defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabel-cfg-'));
    writeFileSync(
      join(dir, 'fabel.config.json'),
      JSON.stringify({
        models: { explorer: 'haiku' },
        verify: { commands: ['npm test'] },
        budget: { defaultUsd: 7 },
        review: { lenses: ['correctness'] },
      }),
    );
    const cfg = loadConfig(dir);
    expect(modelForRole(cfg, 'explorer')).toBe('haiku');
    expect(modelForRole(cfg, 'judge')).toBe('opus');
    expect(cfg.verify.commands).toEqual(['npm test']);
    expect(cfg.budget.defaultUsd).toBe(7);
    expect(cfg.review.lenses).toEqual(['correctness']);
    expect(cfg.review.dryRounds).toBe(2);
  });

  it('rejects invalid config with a clear error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabel-cfg-'));
    writeFileSync(join(dir, 'fabel.config.json'), JSON.stringify({ review: { dryRounds: -1 } }));
    expect(() => loadConfig(dir)).toThrow(/review\.dryRounds/);
  });

  it('explicit override beats config and defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabel-cfg-'));
    const cfg = loadConfig(dir);
    expect(modelForRole(cfg, 'explorer', 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('budget', () => {
  it('tracks spend and remaining', () => {
    const b = new Budget(1.0);
    b.record(0.4);
    b.record(0.3);
    expect(b.spent()).toBeCloseTo(0.7);
    expect(b.remaining()).toBeCloseTo(0.3);
    expect(b.exhausted()).toBe(false);
    b.record(0.5);
    expect(b.exhausted()).toBe(true);
    expect(b.remaining()).toBe(0);
    expect(() => b.assertAvailable('x')).toThrow(/budget exhausted/);
  });

  it('is unlimited without a total', () => {
    const b = new Budget();
    b.record(100);
    expect(b.remaining()).toBe(Infinity);
    expect(() => b.assertAvailable('x')).not.toThrow();
  });

  it('ignores NaN and negative costs', () => {
    const b = new Budget(1);
    b.record(NaN);
    b.record(-5);
    expect(b.spent()).toBe(0);
  });
});
