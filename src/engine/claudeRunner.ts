import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import type { ZodType, ZodTypeDef } from 'zod';
import type { Budget } from './budget.js';
import type { RunState } from './runState.js';

/**
 * The only module that touches the `claude` subprocess. Everything else composes it.
 *
 * Design rules:
 * - argv arrays only (never shell string interpolation); prompt goes via stdin.
 * - NDJSON parsed line-by-line; unknown event types and malformed lines are ignored
 *   (counted) so CLI version drift degrades gracefully.
 * - Machine-consumed stages pass jsonSchema (--json-schema) and validate the
 *   result's structured_output with zod; never parse prose.
 */

export interface StageOptions {
  /** For state files and progress lines. */
  label: string;
  prompt: string;
  /** Appended to the system prompt (persona/doctrine text). */
  systemPrompt?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  /** Per-stage cost cap, passed to claude --max-budget-usd. */
  maxBudgetUsd?: number;
  /** Restrict the base tool set (--tools). */
  tools?: string[];
  /** Permission rules (--allowedTools), e.g. "Bash(npm test:*)". */
  allowedTools?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'dontAsk' | 'plan' | 'bypassPermissions';
  /** Inline subagent definitions (--agents), from promptSource.toAgentsJson. */
  agentsJson?: string;
  /** JSON Schema forced on the final output (--json-schema). */
  jsonSchema?: object;
  /** Skip hooks/plugins/CLAUDE.md — for deterministic worker calls. */
  bare?: boolean;
  /** Resume an existing session id (fix rounds keep implement context). */
  resume?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface StageResult {
  ok: boolean;
  label: string;
  resultText: string;
  structuredOutput?: unknown;
  sessionId?: string;
  costUsd: number;
  numTurns?: number;
  durationMs: number;
  exitCode: number | null;
  malformedLines: number;
  errorMessage?: string;
}

export interface RunnerOptions {
  /** Binary to spawn; FABEL_CLAUDE_BIN overrides for tests. */
  claudeBin?: string;
  budget?: Budget;
  runState?: RunState;
  /** Progress callback (one line per lifecycle event). */
  onProgress?: (line: string) => void;
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export class ClaudeRunner {
  private readonly bin: string;

  constructor(private readonly opts: RunnerOptions = {}) {
    this.bin = opts.claudeBin ?? process.env.FABEL_CLAUDE_BIN ?? 'claude';
  }

  buildArgs(o: StageOptions): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (o.bare) args.push('--bare');
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    if (o.maxTurns !== undefined) args.push('--max-turns', String(o.maxTurns));
    if (o.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(o.maxBudgetUsd));
    if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
    if (o.tools?.length) args.push('--tools', o.tools.join(','));
    if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','));
    if (o.agentsJson) args.push('--agents', o.agentsJson);
    if (o.systemPrompt) args.push('--append-system-prompt', o.systemPrompt);
    if (o.jsonSchema) args.push('--json-schema', JSON.stringify(o.jsonSchema));
    if (o.resume) args.push('--resume', o.resume);
    return args;
  }

  /** Run one claude -p call. Never throws for stage-level failures; check .ok. */
  async runStage(o: StageOptions): Promise<StageResult> {
    this.opts.budget?.assertAvailable(o.label);
    const started = Date.now();
    const seq = this.opts.runState?.nextSeq() ?? 0;
    const eventFile = this.opts.runState?.eventFile(seq, o.label);
    this.opts.onProgress?.(`▸ ${o.label}`);

    const result = await this.spawnOnce(o, eventFile);

    this.opts.budget?.record(result.costUsd);
    this.opts.runState?.recordStage({
      seq,
      label: o.label,
      startedAt: new Date(started).toISOString(),
      durationMs: result.durationMs,
      ok: result.ok,
      sessionId: result.sessionId,
      costUsd: result.costUsd,
      error: result.errorMessage,
    });
    this.opts.onProgress?.(
      `${result.ok ? '✓' : '✗'} ${o.label} (${(result.durationMs / 1000).toFixed(1)}s, $${result.costUsd.toFixed(4)})${result.ok ? '' : ` — ${result.errorMessage ?? 'failed'}`}`,
    );
    return result;
  }

  /**
   * Run a stage whose output must match `schema`. Retries once on transient failure
   * or schema mismatch, then returns null (caller drops the item with a warning).
   */
  async runStructured<T>(
    o: StageOptions,
    schema: ZodType<T, ZodTypeDef, unknown>,
  ): Promise<{ value: T; result: StageResult } | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await this.runStage(attempt === 1 ? o : { ...o, label: `${o.label}(retry)` });
      if (result.ok && result.structuredOutput !== undefined) {
        const parsed = schema.safeParse(result.structuredOutput);
        if (parsed.success) return { value: parsed.data, result };
        this.opts.onProgress?.(`! ${o.label}: structured output failed validation${attempt === 1 ? ', retrying' : ', dropping'}`);
      } else if (!result.ok && result.errorMessage === 'claude binary not found') {
        throw new Error(`fabel: cannot spawn "${this.bin}" — is Claude Code installed? (fabel doctor)`);
      }
    }
    return null;
  }

  private spawnOnce(o: StageOptions, eventFile?: string): Promise<StageResult> {
    const timeoutMs = o.timeoutMs ?? this.opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
      const base: StageResult = {
        ok: false,
        label: o.label,
        resultText: '',
        costUsd: 0,
        durationMs: 0,
        exitCode: null,
        malformedLines: 0,
      };
      const started = Date.now();
      let child;
      try {
        child = spawn(this.bin, this.buildArgs(o), {
          cwd: o.cwd,
          env: { ...process.env, ...o.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        resolve({ ...base, errorMessage: (e as Error).message, durationMs: Date.now() - started });
        return;
      }

      let sawResult = false;
      let stderrTail = '';
      let buffer = '';
      const timer = setTimeout(() => {
        base.errorMessage = `timeout after ${timeoutMs}ms`;
        child.kill('SIGKILL');
      }, timeoutMs);

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        if (eventFile) appendFileSync(eventFile, line + '\n');
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          base.malformedLines++;
          return;
        }
        if (event.type === 'system' && event.subtype === 'init') {
          if (typeof event.session_id === 'string') base.sessionId = event.session_id;
        } else if (event.type === 'result') {
          sawResult = true;
          if (typeof event.session_id === 'string') base.sessionId = event.session_id;
          if (typeof event.result === 'string') base.resultText = event.result;
          if (typeof event.total_cost_usd === 'number') base.costUsd = event.total_cost_usd;
          if (typeof event.num_turns === 'number') base.numTurns = event.num_turns;
          if ('structured_output' in event) base.structuredOutput = event.structured_output;
          base.ok = event.is_error !== true && event.subtype === 'success';
          if (!base.ok && !base.errorMessage) {
            base.errorMessage = typeof event.result === 'string' && event.result ? event.result.slice(0, 300) : `result subtype: ${String(event.subtype)}`;
          }
        }
        // Unknown event types (assistant, api_retry, future additions) are ignored.
      };

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({
          ...base,
          errorMessage: e.code === 'ENOENT' ? 'claude binary not found' : e.message,
          durationMs: Date.now() - started,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (buffer) handleLine(buffer);
        base.exitCode = code;
        base.durationMs = Date.now() - started;
        if (!sawResult) {
          base.ok = false;
          base.errorMessage ??= `exited ${code} without a result event${stderrTail ? `; stderr: ${stderrTail.slice(-300)}` : ''}`;
        } else if (code !== 0 && base.ok) {
          base.ok = false;
          base.errorMessage = `exited ${code} after result event`;
        }
        resolve({ ...base });
      });

      child.stdin.on('error', () => {
        /* EPIPE when the child exits before reading the prompt — surfaced via close */
      });
      child.stdin.end(o.prompt);
    });
  }
}
