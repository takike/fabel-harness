#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { runDoctor, renderDoctor } from './commands/doctor.js';
import { runVerify, renderVerify } from './commands/verify.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };

const program = new Command();
program
  .name('fabel')
  .description('Fable-class orchestration harness driving Claude Code CLI (claude -p)')
  .version(pkg.version);

const progress = (line: string) => process.stderr.write(line + '\n');

program
  .command('doctor')
  .description('check that claude, git, node, auth, plugin, and config are ready')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    const report = await runDoctor();
    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(renderDoctor(report) + '\n');
    process.exitCode = report.ok ? 0 : 1;
  });

program
  .command('verify')
  .description('run the project verify commands (deterministic) and optionally the verifier agent (--e2e)')
  .option('--cmd <command>', 'test command override')
  .option('--base <ref>', 'diff base for scope description', 'HEAD')
  .option('--e2e', 'also exercise the changed behavior with the verifier agent')
  .option('--budget <usd>', 'cost ceiling for agent calls', parseFloat)
  .option('--json', 'machine-readable output')
  .action(async (opts: { cmd?: string; base?: string; e2e?: boolean; budget?: number; json?: boolean }) => {
    const report = await runVerify({
      cmd: opts.cmd,
      base: opts.base,
      e2e: opts.e2e,
      budgetUsd: opts.budget,
      onProgress: opts.json ? undefined : progress,
    });
    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(renderVerify(report) + '\n');
    process.exitCode = report.verdict === 'FAIL' ? 1 : 0;
  });

program.parseAsync(process.argv).catch((e: Error) => {
  process.stderr.write(`fabel: ${e.message}\n`);
  process.exit(1);
});
