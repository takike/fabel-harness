import type { ClaudeRunner } from './claudeRunner.js';
import { BudgetExceededError } from './budget.js';
import type { AgentDef } from './promptSource.js';
import { mapLimit, defaultConcurrency } from './parallel.js';
import { VerdictSchema, VERDICT_JSON_SCHEMA, type Finding, type Verdict } from '../report/schemas.js';

export interface VerifiedFinding extends Finding {
  verdict: Verdict['verdict'];
  verdictEvidence: string;
}

export interface SkepticContext {
  skeptic: AgentDef;
  /** Extra protocol text appended to the skeptic persona. */
  protocol: string;
  scopeDescription: string;
  cwd: string;
  model?: string;
  effort?: string;
  perStageUsd?: number;
  concurrency?: number;
}

/**
 * One skeptic call per finding, in parallel. A finding whose skeptic call fails
 * validation (or the budget) degrades to PLAUSIBLE — a verification failure must
 * never silently upgrade or drop a finding.
 */
export async function verifyFindings(runner: ClaudeRunner, findings: readonly Finding[], ctx: SkepticContext): Promise<VerifiedFinding[]> {
  return mapLimit(findings, ctx.concurrency ?? defaultConcurrency(), async (finding) => {
    const prompt = [
      `Attempt to refute this code-review finding. ${ctx.scopeDescription}`,
      '',
      `Finding: ${finding.summary}`,
      `Anchor: ${finding.file}:${finding.line}`,
      `Severity (reviewer estimate): ${finding.severity}, confidence ${finding.confidence}`,
      `Failure scenario: ${finding.failure_scenario}`,
      '',
      'Trace the actual code path. Verdict CONFIRMED requires a traced file:line chain or an executed repro; when you cannot decide, answer PLAUSIBLE.',
    ].join('\n');
    let value: Verdict | null = null;
    try {
      const structured = await runner.runStructured(
        {
          label: `skeptic:${finding.file}:${finding.line}`,
          prompt,
          systemPrompt: `${ctx.skeptic.prompt}\n\n---\n\n${ctx.protocol}`,
          model: ctx.model,
          effort: ctx.effort,
          bare: true,
          tools: ctx.skeptic.tools,
          permissionMode: 'dontAsk',
          maxBudgetUsd: ctx.perStageUsd,
          jsonSchema: VERDICT_JSON_SCHEMA,
          cwd: ctx.cwd,
        },
        VerdictSchema,
      );
      value = structured?.value ?? null;
    } catch (e) {
      // Budget exhausted mid-pool: degrade remaining findings instead of dying.
      // Anything else (e.g. missing binary) is a real failure — propagate.
      if (!(e instanceof BudgetExceededError)) throw e;
      value = null;
    }
    // Protocol rule: a CONFIRMED without citations/output is malformed → PLAUSIBLE.
    if (value?.verdict === 'CONFIRMED' && !/[\w/.-]+:\d+|exit|output|→/.test(value.evidence)) {
      value = { verdict: 'PLAUSIBLE', evidence: `unsubstantiated confirmation downgraded: ${value.evidence}` };
    }
    return {
      ...finding,
      verdict: value?.verdict ?? 'PLAUSIBLE',
      verdictEvidence: value?.evidence ?? 'skeptic produced no valid verdict; treated as unverified',
    };
  });
}
