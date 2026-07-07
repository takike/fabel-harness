import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { ClaudeRunner } from '../../src/engine/claudeRunner.js';
import { runJudgePanel } from '../../src/engine/judgePanel.js';
import { defaultPluginDir, loadAgent } from '../../src/engine/promptSource.js';

const FAKE = join(__dirname, '..', 'fixtures', 'fake-claude', 'claude');
const MAP = join(__dirname, '..', 'fixtures', 'judge', 'map.json');

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

const judge = loadAgent(defaultPluginDir(), 'judge');

describe('judge panel', () => {
  it('picks the candidate with the best median rank', async () => {
    const runner = new ClaudeRunner({});
    const diffs = [
      '--- a/x\n+++ b/x\nglobal-cache-marker',
      '--- a/x\n+++ b/x\nminimal-fix-only-marker',
      '--- a/x\n+++ b/x\nmiddling-marker',
    ];
    const result = await runJudgePanel(runner, diffs, { judge, cwd: process.cwd() }, 3);
    expect(result.winner).toBe(1);
    expect(result.seats).toBe(3);
    expect(result.medianRanks[1]).toBe(1);
    expect(result.medianRanks[0]).toBe(3);
    expect(result.totals).toHaveLength(3);
    expect(result.totals[0]).toEqual([23, 43, 34]);
  });

  it('bumps an even panel to odd', async () => {
    const runner = new ClaudeRunner({});
    const diffs = ['global-cache-marker', 'minimal-fix-only-marker'];
    const result = await runJudgePanel(runner, diffs, { judge, cwd: process.cwd() }, 2);
    expect(result.seats).toBe(3);
    expect(result.notes.join(' ')).toContain('bumped');
    expect(result.winner).toBe(1);
  });

  it('breaks a full tie deterministically via extra seat then mean total', async () => {
    const runner = new ClaudeRunner({});
    // Both candidates hit the same scenario → identical scores → tie all the way down.
    const diffs = ['middling-marker one', 'middling-marker two'];
    const result = await runJudgePanel(runner, diffs, { judge, cwd: process.cwd() }, 3);
    expect(result.winner).toBe(0);
    expect(result.seats).toBe(4); // 3 + 1 tie-break seat
    expect(result.notes.join(' ')).toContain('tie');
  });
});
