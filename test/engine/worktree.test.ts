import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertCleanTree,
  createCandidateWorktrees,
  commitCandidateWork,
  candidateDiff,
  mergeWinner,
  removeCandidateWorktrees,
} from '../../src/engine/worktree.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd }).toString();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fabel-wt-'));
  git(dir, ['init', '-q']);
  writeFileSync(join(dir, 'a.txt'), 'original\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

describe('worktree lifecycle', () => {
  it('refuses a dirty tree', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.txt'), 'modified\n');
    expect(() => assertCleanTree(dir)).toThrow(/uncommitted changes/);
    expect(() => createCandidateWorktrees(dir, 'run1', 2, 'HEAD')).toThrow(/uncommitted/);
  });

  it('tolerates untracked files', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'scratch.txt'), 'untracked\n');
    expect(() => assertCleanTree(dir)).not.toThrow();
  });

  it('creates, commits, diffs, merges the winner, and cleans up', () => {
    const dir = makeRepo();
    const wts = createCandidateWorktrees(dir, 'run1', 2, 'HEAD');
    expect(wts).toHaveLength(2);
    expect(existsSync(wts[0]!.path)).toBe(true);

    // Candidate 0 changes a.txt; candidate 1 does nothing.
    writeFileSync(join(wts[0]!.path, 'a.txt'), 'candidate zero wins\n');
    expect(commitCandidateWork(wts[0]!, 'cand 0')).toBe(true);
    expect(commitCandidateWork(wts[1]!, 'cand 1')).toBe(false);

    expect(candidateDiff(wts[0]!)).toContain('candidate zero wins');
    expect(candidateDiff(wts[1]!)).toBe('');

    const merge = mergeWinner(dir, wts[0]!);
    expect(merge.ok).toBe(true);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toContain('candidate zero wins');
    // Squash merge leaves the change staged, not committed.
    expect(git(dir, ['status', '--porcelain'])).toContain('M  a.txt');

    removeCandidateWorktrees(dir, wts);
    expect(existsSync(wts[0]!.path)).toBe(false);
    expect(git(dir, ['branch', '--list', 'fabel/*']).trim()).toBe('');
  });

  it('keep=true preserves worktrees', () => {
    const dir = makeRepo();
    const wts = createCandidateWorktrees(dir, 'run2', 1, 'HEAD');
    removeCandidateWorktrees(dir, wts, true);
    expect(existsSync(wts[0]!.path)).toBe(true);
    removeCandidateWorktrees(dir, wts);
  });

  it('reports a conflicting merge without corrupting the tree', () => {
    const dir = makeRepo();
    const wts = createCandidateWorktrees(dir, 'run3', 1, 'HEAD');
    writeFileSync(join(wts[0]!.path, 'a.txt'), 'branch version\n');
    commitCandidateWork(wts[0]!, 'cand');
    // Diverge the main tree so the squash merge conflicts.
    writeFileSync(join(dir, 'a.txt'), 'main version\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'diverge']);

    const merge = mergeWinner(dir, wts[0]!);
    expect(merge.ok).toBe(false);
    expect(merge.detail).toContain('failed');
    removeCandidateWorktrees(dir, wts);
  });
});
