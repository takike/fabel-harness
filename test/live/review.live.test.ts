import { describe, it, expect } from 'vitest';
import { mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runReview } from '../../src/commands/review.js';

/**
 * Opt-in live smoke against a real `claude` binary (FABEL_LIVE=1 npm run test:live).
 * Reviews a repo with one planted bug (pagination off-by-one) and one red herring
 * (whitelisted "SQL injection"). Uses haiku + a hard budget to bound cost.
 */
describe.runIf(process.env.FABEL_LIVE === '1')('live: fabel review on buggy-repo', () => {
  it(
    'confirms the planted bug and refutes the red herring',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fabel-live-'));
      cpSync(join(__dirname, '..', 'fixtures', 'buggy-repo'), dir, { recursive: true });
      writeFileSync(
        join(dir, 'fabel.config.json'),
        JSON.stringify({
          models: { reviewer: 'haiku', skeptic: 'haiku' },
          review: { lenses: ['correctness', 'security'], dryRounds: 1, maxRounds: 1 },
        }),
      );
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir });

      const report = await runReview({
        cwd: dir,
        base: 'HEAD~0', // empty diff → reviewers fall back to reviewing HEAD per scope prompt
        budgetUsd: 3,
        onProgress: (l) => process.stderr.write(l + '\n'),
      });

      // The planted off-by-one must be found and survive the skeptic.
      const confirmedText = report.confirmed.map((f) => `${f.file} ${f.summary}`).join(' ');
      expect(confirmedText).toMatch(/paginate|slice|off.by.one|limit/i);
      // The whitelisted "injection" must NOT be reported as confirmed.
      expect(report.confirmed.some((f) => /injection/i.test(f.summary))).toBe(false);
      expect(report.costUsd).toBeLessThan(3.5);
    },
    10 * 60 * 1000,
  );
});
