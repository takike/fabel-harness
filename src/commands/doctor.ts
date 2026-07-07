import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tryExecFile } from '../engine/localExec.js';
import { loadConfig, CONFIG_FILENAME } from '../config.js';
import { defaultPluginDir, listAgents } from '../engine/promptSource.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export async function runDoctor(cwd: string = process.cwd()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const bin = process.env.FABEL_CLAUDE_BIN ?? 'claude';

  const version = await tryExecFile(bin, ['--version']);
  checks.push({
    name: 'claude binary',
    ok: version.ok,
    detail: version.ok ? `${bin}: ${version.stdout.trim()}` : `cannot run "${bin} --version" — install Claude Code (https://code.claude.com)`,
  });

  const node = process.versions.node;
  const nodeMajor = Number(node.split('.')[0]);
  checks.push({ name: 'node', ok: nodeMajor >= 18, detail: `v${node}${nodeMajor >= 18 ? '' : ' (need >=18)'}` });

  const git = await tryExecFile('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  checks.push({
    name: 'git repository',
    ok: git.ok && git.stdout.trim() === 'true',
    detail: git.ok ? cwd : 'not inside a git work tree — solve/review need one',
  });

  const worktree = await tryExecFile('git', ['worktree', 'list'], cwd);
  checks.push({ name: 'git worktree support', ok: worktree.ok, detail: worktree.ok ? 'available' : 'git worktree failed — multi-candidate mode unavailable' });

  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOauth = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const hasCredFile = existsSync(join(homedir(), '.claude', '.credentials.json'));
  checks.push({
    name: 'auth',
    ok: hasApiKey || hasOauth || hasCredFile,
    detail: hasApiKey
      ? 'ANTHROPIC_API_KEY set (required for --bare worker calls)'
      : hasOauth
        ? 'CLAUDE_CODE_OAUTH_TOKEN set'
        : hasCredFile
          ? 'subscription credentials found (~/.claude); note: --bare worker calls need ANTHROPIC_API_KEY'
          : 'no ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / ~/.claude credentials found',
  });

  try {
    const pluginDir = defaultPluginDir();
    const agents = listAgents(pluginDir);
    checks.push({ name: 'bundled plugin', ok: agents.length >= 7, detail: `${pluginDir} (${agents.length} agents)` });
  } catch (e) {
    checks.push({ name: 'bundled plugin', ok: false, detail: (e as Error).message });
  }

  try {
    loadConfig(cwd);
    checks.push({
      name: 'config',
      ok: true,
      detail: existsSync(join(cwd, CONFIG_FILENAME)) ? `${CONFIG_FILENAME} loaded` : `no ${CONFIG_FILENAME} (defaults in effect)`,
    });
  } catch (e) {
    checks.push({ name: 'config', ok: false, detail: (e as Error).message });
  }

  // Auth being absent degrades features but should not fail doctor outright.
  const required = ['claude binary', 'node', 'git repository', 'bundled plugin', 'config'];
  const ok = checks.filter((c) => required.includes(c.name)).every((c) => c.ok);
  return { ok, checks };
}

export function renderDoctor(report: DoctorReport): string {
  const lines = report.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name.padEnd(22)} ${c.detail}`);
  lines.push('', report.ok ? 'fabel is ready.' : 'fabel is NOT ready — fix the ✗ items above.');
  return lines.join('\n');
}
