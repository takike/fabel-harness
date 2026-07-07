import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, modelForRole, effortForRole, type FabelConfig } from '../config.js';
import { runLocalCommand, type CommandOutcome } from '../engine/localExec.js';
import { ClaudeRunner } from '../engine/claudeRunner.js';
import { defaultPluginDir, loadAgent, loadSkillBody } from '../engine/promptSource.js';
import { VerifyVerdictSchema, VERIFY_JSON_SCHEMA, type VerifyVerdict } from '../report/schemas.js';
import { Budget } from '../engine/budget.js';
import { RunState } from '../engine/runState.js';

export interface VerifyOptions {
  cwd?: string;
  /** Explicit command override (--cmd). */
  cmd?: string;
  /** Diff base for scope description (--base). */
  base?: string;
  /** Also run the verifier agent to exercise behavior end-to-end (--e2e). */
  e2e?: boolean;
  budgetUsd?: number;
  onProgress?: (line: string) => void;
}

export interface VerifyReport {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL';
  commands: CommandOutcome[];
  agent?: VerifyVerdict | null;
  markerWritten: boolean;
  costUsd: number;
  notes: string[];
}

/** config > --cmd > auto-detect from common manifests. */
export function detectVerifyCommands(cwd: string, config: FabelConfig, override?: string): string[] {
  if (override) return [override];
  if (config.verify.commands.length) return config.verify.commands;
  const detected: string[] = [];
  const pkgFile = join(cwd, 'package.json');
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) detected.push('npm test');
      if (pkg.scripts?.build) detected.push('npm run build');
    } catch {
      /* unparseable package.json — fall through to other manifests */
    }
  }
  if (!detected.length && existsSync(join(cwd, 'Makefile'))) {
    const mk = readFileSync(join(cwd, 'Makefile'), 'utf8');
    if (/^test:/m.test(mk)) detected.push('make test');
  }
  if (!detected.length && (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'pytest.ini')))) {
    detected.push('pytest');
  }
  if (!detected.length && existsSync(join(cwd, 'Cargo.toml'))) {
    detected.push('cargo test');
  }
  return detected;
}

/** Hash of the working-tree diff, matching plugin/scripts/verify-gate.sh. */
export function treeStateHash(cwd: string): string | undefined {
  const diff = spawnSync('git', ['diff', 'HEAD'], { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (diff.status !== 0) return undefined;
  const hash = spawnSync('git', ['hash-object', '--stdin'], { cwd, input: diff.stdout });
  if (hash.status !== 0) return undefined;
  return hash.stdout.toString().trim();
}

export async function runVerify(opts: VerifyOptions = {}): Promise<VerifyReport> {
  const cwd = opts.cwd ?? process.cwd();
  const config = loadConfig(cwd);
  const notes: string[] = [];
  const commands = detectVerifyCommands(cwd, config, opts.cmd);

  const outcomes: CommandOutcome[] = [];
  for (const cmd of commands) {
    opts.onProgress?.(`▸ ${cmd}`);
    const outcome = await runLocalCommand(cmd, cwd, config.verify.timeoutSec);
    opts.onProgress?.(`${outcome.exitCode === 0 ? '✓' : '✗'} ${cmd} (exit ${outcome.exitCode ?? 'spawn-error'}${outcome.timedOut ? ', timed out' : ''})`);
    outcomes.push(outcome);
  }
  const commandsFailed = outcomes.some((o) => o.exitCode !== 0);
  const commandsRan = outcomes.length > 0;
  if (!commandsRan) notes.push('no verify commands configured or detected — configure verify.commands in fabel.config.json');

  // Optional end-to-end pass by the verifier agent (same persona as the plugin).
  let agent: VerifyVerdict | null | undefined;
  let costUsd = 0;
  if (opts.e2e) {
    const pluginDir = defaultPluginDir();
    const verifier = loadAgent(pluginDir, 'verifier');
    const doctrine = loadSkillBody(pluginDir, 'doctrine');
    const budget = new Budget(opts.budgetUsd ?? config.budget.defaultUsd);
    const runState = RunState.create(cwd, 'verify');
    const runner = new ClaudeRunner({ budget, runState, onProgress: opts.onProgress });
    const diffStat = spawnSync('git', ['diff', '--stat', opts.base ?? 'HEAD'], { cwd }).stdout?.toString() ?? '';
    const structured = await runner.runStructured(
      {
        label: 'verifier',
        prompt: [
          `Verify the current changes in ${cwd} end-to-end.`,
          `Diff scope (git diff --stat ${opts.base ?? 'HEAD'}):\n${diffStat || '(empty diff)'}`,
          commandsRan
            ? `Deterministic command results (already run — do NOT just re-run these; exercise the changed behavior itself):\n${outcomes.map((o) => `- ${o.command} → exit ${o.exitCode}`).join('\n')}`
            : 'No verify commands are configured; detect and run the appropriate ones, then exercise the changed behavior.',
        ].join('\n\n'),
        systemPrompt: `${verifier.prompt}\n\n---\n\n${doctrine}`,
        model: modelForRole(config, 'verifier'),
        effort: effortForRole(config, 'verifier'),
        permissionMode: 'acceptEdits',
        maxBudgetUsd: config.budget.perStageUsd,
        jsonSchema: VERIFY_JSON_SCHEMA,
        cwd,
      },
      VerifyVerdictSchema,
    );
    agent = structured?.value ?? null;
    costUsd = budget.spent();
    if (agent === null) notes.push('verifier agent produced no valid verdict — falling back to deterministic results');
    runState.finish({ agent, commands: outcomes.map((o) => ({ command: o.command, exitCode: o.exitCode })) });
  }

  // The deterministic layer decides when commands exist; the agent refines PASS→PARTIAL
  // (belt and suspenders: a model can downgrade, never upgrade, a command verdict).
  let verdict: VerifyReport['verdict'];
  if (commandsRan) {
    verdict = commandsFailed ? 'FAIL' : 'PASS';
    if (verdict === 'PASS' && agent && agent.verdict !== 'PASS') {
      verdict = agent.verdict === 'FAIL' ? 'FAIL' : 'PARTIAL';
      notes.push(`downgraded by verifier agent: ${agent.verdict}`);
    }
  } else if (agent) {
    verdict = agent.verdict;
  } else {
    verdict = 'PARTIAL';
  }

  let markerWritten = false;
  if (verdict === 'PASS') {
    const hash = treeStateHash(cwd);
    if (hash !== undefined) {
      mkdirSync(join(cwd, '.fabel'), { recursive: true });
      writeFileSync(join(cwd, '.fabel', 'verified'), hash + '\n');
      markerWritten = true;
    } else {
      notes.push('could not record .fabel/verified (not a git repo?)');
    }
  }

  return { verdict, commands: outcomes, agent, markerWritten, costUsd, notes };
}

export function renderVerify(report: VerifyReport): string {
  const lines = [`VERDICT: ${report.verdict}`];
  for (const o of report.commands) {
    lines.push(`- ${o.command} → exit ${o.exitCode ?? 'spawn-error'}${o.timedOut ? ' (timed out)' : ''}`);
    if (o.exitCode !== 0 && o.outputTail.trim()) {
      lines.push('  ' + o.outputTail.trim().split('\n').slice(-10).join('\n  '));
    }
  }
  if (report.agent) {
    lines.push(`verifier agent: ${report.agent.verdict}`);
    for (const e of report.agent.evidence) lines.push(`  · ${e}`);
    for (const u of report.agent.unverified) lines.push(`  unverified: ${u}`);
  }
  for (const n of report.notes) lines.push(`note: ${n}`);
  if (report.markerWritten) lines.push('.fabel/verified written');
  if (report.costUsd > 0) lines.push(`cost: $${report.costUsd.toFixed(4)}`);
  return lines.join('\n');
}
