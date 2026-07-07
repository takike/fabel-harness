import { z } from 'zod';

/**
 * Zod schemas validate everything machine-consumed from model output, paired with
 * hand-written JSON Schemas passed to `claude --json-schema` so the model is forced
 * into the same shape at generation time. Keep each pair in sync.
 */

export const SeveritySchema = z.enum(['critical', 'major', 'minor']);
export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const FindingSchema = z.object({
  summary: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().nonnegative().default(0),
  failure_scenario: z.string().min(1),
  severity: SeveritySchema,
  confidence: ConfidenceSchema,
  lens: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const FindingsReportSchema = z.object({
  findings: z.array(FindingSchema),
});
export type FindingsReport = z.infer<typeof FindingsReportSchema>;

export const FINDINGS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer', minimum: 0 },
          failure_scenario: { type: 'string' },
          severity: { enum: ['critical', 'major', 'minor'] },
          confidence: { enum: ['high', 'medium', 'low'] },
        },
        required: ['summary', 'file', 'line', 'failure_scenario', 'severity', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

export const VerdictSchema = z.object({
  verdict: z.enum(['CONFIRMED', 'REFUTED', 'PLAUSIBLE']),
  evidence: z.string().min(1),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { enum: ['CONFIRMED', 'REFUTED', 'PLAUSIBLE'] },
    evidence: { type: 'string' },
  },
  required: ['verdict', 'evidence'],
  additionalProperties: false,
} as const;

export const JudgeScoreSchema = z.object({
  scores: z.object({
    correctness: z.number().min(0).max(10),
    minimality: z.number().min(0).max(10),
    convention_fit: z.number().min(0).max(10),
    test_quality: z.number().min(0).max(10),
    risk: z.number().min(0).max(10),
  }),
  total: z.number(),
  justification: z.string(),
});
export type JudgeScore = z.infer<typeof JudgeScoreSchema>;

export const JUDGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'object',
      properties: {
        correctness: { type: 'number', minimum: 0, maximum: 10 },
        minimality: { type: 'number', minimum: 0, maximum: 10 },
        convention_fit: { type: 'number', minimum: 0, maximum: 10 },
        test_quality: { type: 'number', minimum: 0, maximum: 10 },
        risk: { type: 'number', minimum: 0, maximum: 10 },
      },
      required: ['correctness', 'minimality', 'convention_fit', 'test_quality', 'risk'],
      additionalProperties: false,
    },
    total: { type: 'number' },
    justification: { type: 'string' },
  },
  required: ['scores', 'total', 'justification'],
  additionalProperties: false,
} as const;

export const VerifyVerdictSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL', 'PARTIAL']),
  evidence: z.array(z.string()),
  unverified: z.array(z.string()).default([]),
});
export type VerifyVerdict = z.infer<typeof VerifyVerdictSchema>;

export const VERIFY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { enum: ['PASS', 'FAIL', 'PARTIAL'] },
    evidence: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'evidence', 'unverified'],
  additionalProperties: false,
} as const;

/** Plan produced by the planner stage (solve pipeline). */
export const PlanSchema = z.object({
  goal: z.string().min(1),
  constraints: z.array(z.string()),
  steps: z.array(z.string()).min(1),
  test_strategy: z.string(),
  verification: z.string(),
  risks: z.array(z.string()),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'string' }, minItems: 1 },
    test_strategy: { type: 'string' },
    verification: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['goal', 'constraints', 'steps', 'test_strategy', 'verification', 'risks'],
  additionalProperties: false,
} as const;

/** Research synthesis / researcher answer. */
export const ResearchAnswerSchema = z.object({
  answer: z.string().min(1),
  evidence: z.array(z.object({ claim: z.string(), kind: z.enum(['observed', 'inferred']), citation: z.string() })),
  gaps: z.array(z.string()).default([]),
});
export type ResearchAnswer = z.infer<typeof ResearchAnswerSchema>;

export const RESEARCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          kind: { enum: ['observed', 'inferred'] },
          citation: { type: 'string' },
        },
        required: ['claim', 'kind', 'citation'],
        additionalProperties: false,
      },
    },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'evidence', 'gaps'],
  additionalProperties: false,
} as const;
