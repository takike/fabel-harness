import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { runDoctor, renderDoctor } from '../../src/commands/doctor.js';

const FAKE = join(__dirname, '..', 'fixtures', 'fake-claude', 'claude');

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FABEL_CLAUDE_BIN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FABEL_CLAUDE_BIN;
  else process.env.FABEL_CLAUDE_BIN = saved;
});

describe('doctor', () => {
  it('reports the fake claude version and passes required checks in this repo', async () => {
    process.env.FABEL_CLAUDE_BIN = FAKE;
    const report = await runDoctor(join(__dirname, '..', '..'));
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName['claude binary']!.ok).toBe(true);
    expect(byName['claude binary']!.detail).toContain('9.9.9-fake');
    expect(byName['node']!.ok).toBe(true);
    expect(byName['git repository']!.ok).toBe(true);
    expect(byName['bundled plugin']!.ok).toBe(true);
    expect(byName['bundled plugin']!.detail).toContain('7 agents');
    expect(byName['config']!.ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('fails when the claude binary is missing', async () => {
    process.env.FABEL_CLAUDE_BIN = '/nonexistent/claude-nope';
    const report = await runDoctor(join(__dirname, '..', '..'));
    expect(report.ok).toBe(false);
    expect(renderDoctor(report)).toContain('NOT ready');
  });
});
