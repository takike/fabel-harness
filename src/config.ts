import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.object({
  models: z.record(z.string()).default({}),
  effort: z.record(z.string()).default({}),
  verify: z
    .object({
      commands: z.array(z.string()).default([]),
      timeoutSec: z.number().int().positive().default(600),
    })
    .default({}),
  budget: z
    .object({
      defaultUsd: z.number().positive().optional(),
      perStageUsd: z.number().positive().optional(),
    })
    .default({}),
  review: z
    .object({
      lenses: z.array(z.string()).min(1).default(['correctness', 'security', 'concurrency', 'tests']),
      dryRounds: z.number().int().positive().default(2),
      maxRounds: z.number().int().positive().default(4),
    })
    .default({}),
  permissions: z
    .object({
      extraAllowedTools: z.array(z.string()).default([]),
    })
    .default({}),
});

export type FabelConfig = z.infer<typeof ConfigSchema>;

/** Role → model routing. Agent frontmatter is the base; config.models overrides. */
export const DEFAULT_MODELS: Record<string, string> = {
  implement: 'opus',
  planner: 'opus',
  reviewer: 'opus',
  skeptic: 'opus',
  judge: 'opus',
  explorer: 'sonnet',
  verifier: 'sonnet',
  researcher: 'sonnet',
};

export const DEFAULT_EFFORT: Record<string, string> = {
  implement: 'xhigh',
  default: 'high',
};

export const CONFIG_FILENAME = 'fabel.config.json';

/**
 * Read-only Bash rules for worker calls (reviewers/skeptics/explorers run with
 * --permission-mode dontAsk, which auto-denies anything not allowlisted — without
 * these they cannot even `git diff`). Deliberately excludes code execution; add
 * e.g. "Bash(node -e:*)" to permissions.extraAllowedTools to let skeptics run repros.
 */
export const READONLY_BASH_ALLOWLIST: string[] = [
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git status:*)',
  'Bash(git blame:*)',
  'Bash(git grep:*)',
  'Bash(git branch:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(grep:*)',
  'Bash(rg:*)',
  'Bash(find:*)',
];

export function workerAllowedTools(config: FabelConfig): string[] {
  return [...READONLY_BASH_ALLOWLIST, ...config.permissions.extraAllowedTools];
}

export function loadConfig(cwd: string = process.cwd()): FabelConfig {
  const file = join(cwd, CONFIG_FILENAME);
  if (!existsSync(file)) return ConfigSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`fabel: ${CONFIG_FILENAME} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`fabel: invalid ${CONFIG_FILENAME}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

export function modelForRole(config: FabelConfig, role: string, override?: string): string | undefined {
  return override ?? config.models[role] ?? DEFAULT_MODELS[role];
}

export function effortForRole(config: FabelConfig, role: string, override?: string): string | undefined {
  return override ?? config.effort[role] ?? config.effort['default'] ?? DEFAULT_EFFORT[role] ?? DEFAULT_EFFORT['default'];
}
