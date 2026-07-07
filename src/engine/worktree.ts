import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface CandidateWorktree {
  index: number;
  path: string;
  branch: string;
  /** Concrete SHA the candidate branched from — 'HEAD' would resolve to the branch tip inside the worktree. */
  baseSha: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }).toString();
}

/** Modified/staged tracked files block candidate mode; untracked files are fine. */
export function assertCleanTree(cwd: string): void {
  const status = git(cwd, ['status', '--porcelain', '--untracked-files=no']).trim();
  if (status) {
    throw new Error(`fabel: working tree has uncommitted changes — commit or stash before multi-candidate mode:\n${status}`);
  }
}

export function createCandidateWorktrees(cwd: string, runId: string, count: number, base: string): CandidateWorktree[] {
  assertCleanTree(cwd);
  const baseSha = git(cwd, ['rev-parse', base]).trim();
  const root = join(cwd, '.fabel', 'worktrees', runId);
  mkdirSync(root, { recursive: true });
  const worktrees: CandidateWorktree[] = [];
  for (let i = 0; i < count; i++) {
    const path = join(root, `cand-${i}`);
    const branch = `fabel/cand-${runId}-${i}`;
    git(cwd, ['worktree', 'add', '--quiet', path, '-b', branch, baseSha]);
    worktrees.push({ index: i, path, branch, baseSha });
  }
  return worktrees;
}

/** Commit whatever the candidate session changed, so the branch carries the work. */
export function commitCandidateWork(wt: CandidateWorktree, message: string): boolean {
  git(wt.path, ['add', '-A']);
  const staged = git(wt.path, ['status', '--porcelain']).trim();
  if (!staged) return false;
  git(wt.path, ['-c', 'user.email=fabel@local', '-c', 'user.name=fabel', 'commit', '--quiet', '-m', message]);
  return true;
}

export function candidateDiff(wt: CandidateWorktree): string {
  return git(wt.path, ['diff', wt.baseSha, '--', '.', `:(exclude).fabel`]);
}

/**
 * Squash-merge the winning branch into the main tree, leaving the changes staged
 * but uncommitted so the user (or the verify loop) sees them as working-tree state.
 */
export function mergeWinner(cwd: string, winner: CandidateWorktree): { ok: boolean; detail: string } {
  try {
    git(cwd, ['merge', '--squash', '--quiet', winner.branch]);
    return { ok: true, detail: `squash-merged ${winner.branch} (staged, not committed)` };
  } catch (e) {
    try {
      git(cwd, ['merge', '--abort']);
    } catch {
      /* squash merges may leave nothing to abort */
    }
    return { ok: false, detail: `merge of ${winner.branch} failed: ${(e as Error).message}` };
  }
}

export function removeCandidateWorktrees(cwd: string, worktrees: CandidateWorktree[], keep = false): void {
  if (keep) return;
  for (const wt of worktrees) {
    try {
      git(cwd, ['worktree', 'remove', '--force', wt.path]);
    } catch {
      rmSync(resolve(wt.path), { recursive: true, force: true });
      try {
        git(cwd, ['worktree', 'prune']);
      } catch {
        /* best effort */
      }
    }
    try {
      git(cwd, ['branch', '-D', wt.branch]);
    } catch {
      /* branch may be checked out elsewhere or already gone */
    }
  }
}
