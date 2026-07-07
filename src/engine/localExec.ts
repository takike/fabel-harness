import { spawn, execFile } from 'node:child_process';

export interface CommandOutcome {
  command: string;
  exitCode: number | null;
  /** Last ~4KB of interleaved stdout+stderr. */
  outputTail: string;
  timedOut: boolean;
}

/**
 * Run a user-configured shell command (verify commands from fabel.config.json or
 * --cmd). These are the user's own strings, so a shell is intentional here — fabel
 * itself never interpolates values into them.
 */
export function runLocalCommand(command: string, cwd: string, timeoutSec: number): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-4096);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSec * 1000);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ command, exitCode: null, outputTail: e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ command, exitCode: code, outputTail: tail, timedOut });
    });
  });
}

/** execFile promisified with a captured-output result instead of a throw. */
export function tryExecFile(bin: string, args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
    });
  });
}
