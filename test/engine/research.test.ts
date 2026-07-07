import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runResearch } from '../../src/commands/research.js';
import { renderResearchReport } from '../../src/report/render.js';

const FAKE = join(__dirname, '..', 'fixtures', 'fake-claude', 'claude');
const MAP = join(__dirname, '..', 'fixtures', 'research', 'map.json');

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['FABEL_CLAUDE_BIN', 'FAKE_CLAUDE_MAP']) saved[k] = process.env[k];
  process.env.FABEL_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_MAP = MAP;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('runResearch pipeline (offline, scripted claude)', () => {
  it('decomposes, sweeps, deep-reads, synthesizes, and attacks load-bearing claims', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabel-research-'));
    const report = await runResearch({ question: 'How does retry handling work?', cwd: dir });

    expect(report.subQuestions).toEqual(['Where is retry logic implemented?', 'How are retries configured?']);
    expect(report.answer?.answer).toContain('withRetry()');
    expect(report.answer?.evidence).toHaveLength(3);
    // 3 attacks: observed claims first; the RETRY_MAX claim comes back REFUTED.
    expect(report.attacks).toHaveLength(3);
    const refuted = report.attacks.filter((a) => a.verdict === 'REFUTED');
    expect(refuted).toHaveLength(1);
    expect(refuted[0]!.claim).toContain('RETRY_MAX');
    expect(report.notes.join(' ')).toContain('REFUTED');

    const rendered = renderResearchReport(report);
    expect(rendered).toContain('skeptic: REFUTED');
    expect(rendered).toContain('Refuted claims');
    expect(rendered).toContain('src/retry.ts:12');
  });

  it('budget exhaustion returns a partial report instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fabel-research-'));
    const report = await runResearch({ question: 'How does retry handling work?', cwd: dir, budgetUsd: 0.03 });
    expect(report.answer).toBeNull();
    expect(report.notes.join(' ')).toContain('budget exhausted');
  });
});
