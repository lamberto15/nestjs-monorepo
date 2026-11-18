import { parseDuration } from '@nestjs/workflows/core';
import { z } from 'zod';
import { validationException } from '../../core/http/problem-details.filter.js';
import { type ApprovalCondition, COMPARISONS } from './approval-modes.js';

/**
 * An approval policy as data: what code declares as an action's default
 * and administrators store as versions of their own
 * (`PUT /v1/approvals/policies/{key}`). JSON all through, so it is stored,
 * versioned and copied onto each request. Approver rules, stage modes and
 * conditions are named by `type` with their parameters beside it
 * (`{ "type": "role", "role": "editor" }`).
 */

/** A duration as the workflows take it: `30m`, `8h`, `2d`, `1w`. */
export const durationSchema = z
  .string()
  .regex(/^\d+(ms|s|m|h|d|w)$/, 'a duration: 30m, 8h, 2d, 1w')
  .meta({ example: '2d' });

/** Milliseconds of a validated duration. */
export const millis = (duration: string) => parseDuration(duration as never);

/** Who may decide a stage. */
export const RULES = {
  role: z
    .object({ type: z.literal('role'), role: z.string().min(1).max(100) })
    .strict()
    .describe('Users holding a role (its key, or its id)'),
  unitRole: z
    .object({
      type: z.literal('unitRole'),
      role: z.string().min(1).max(100),
      levelsUp: z.number().int().min(0).max(20).default(0),
      nearest: z.boolean().default(true),
    })
    .strict()
    .describe(
      "Users holding a role among the members of the requester's units: `levelsUp` starts higher, `nearest` goes up until someone other than the requester is found",
    ),
  permission: z
    .object({
      type: z.literal('permission'),
      action: z.string().min(1).max(100),
      subject: z.string().min(1).max(100).optional(),
    })
    .strict()
    .describe('Users who may do an action on the record'),
  users: z
    .object({
      type: z.literal('users'),
      userIds: z.array(z.uuid()).min(1).max(50),
    })
    .strict()
    .describe('Named users'),
};
export const ruleSchema = z.discriminatedUnion('type', [
  RULES.role,
  RULES.unitRole,
  RULES.permission,
  RULES.users,
]);
export type ApproverRule = z.output<typeof ruleSchema>;

/** How a stage completes (approval-modes.ts). */
export const MODES = {
  any: z
    .object({ type: z.literal('any') })
    .strict()
    .describe('Any approver: the first decision decides'),
  all: z
    .object({ type: z.literal('all') })
    .strict()
    .describe('All approvers'),
  quorum: z
    .object({ type: z.literal('quorum'), n: z.number().int().min(1).max(100) })
    .strict()
    .describe('A quorum of approvers (people, never lowered)'),
};
export const modeSchema = z.discriminatedUnion('type', [
  MODES.any,
  MODES.all,
  MODES.quorum,
]);

const payloadCondition = z
  .object({
    type: z.literal('payload'),
    path: z.string().min(1).max(200),
    op: z.enum(COMPARISONS),
    value: z.unknown().optional(),
  })
  .strict()
  .refine((c) => c.op === 'exists' || c.value !== undefined, {
    message: 'value is required for this op',
    path: ['value'],
  })
  .refine((c) => !['in', 'notIn'].includes(c.op) || Array.isArray(c.value), {
    message: 'in and notIn take a list',
    path: ['value'],
  });

/** `payload` (a value of the proposed change), and `all` / `any` / `not` of others. */
export const conditionSchema: z.ZodType<ApprovalCondition> = z.lazy(() =>
  z.union([
    payloadCondition,
    z
      .object({
        type: z.enum(['all', 'any']),
        conditions: z.array(conditionSchema).min(1).max(20),
      })
      .strict(),
    z.object({ type: z.literal('not'), condition: conditionSchema }).strict(),
  ]),
) as z.ZodType<ApprovalCondition>;

const depthOf = (condition: ApprovalCondition): number =>
  condition.type === 'payload'
    ? 1
    : condition.type === 'not'
      ? 1 + depthOf(condition.condition)
      : 1 + Math.max(...condition.conditions.map(depthOf));

const ruleList = z.array(ruleSchema).min(1).max(10);

export const stageSchema = z
  .object({
    name: z.string().trim().min(1).max(100).meta({ example: 'Review' }),
    approvers: ruleList.describe(
      'Every active member any of these rules names is assigned when the stage starts (never the requester).',
    ),
    mode: modeSchema.default({ type: 'any' }),
    remindAfter: durationSchema
      .optional()
      .describe('Remind the approvers who have not decided after this long.'),
    dueAfter: durationSchema
      .optional()
      .describe('The stage is overdue after this long: then `onOverdue`.'),
    onOverdue: z.enum(['expire', 'escalate']).default('expire'),
    escalateTo: ruleList
      .optional()
      .describe(
        'With `onOverdue: escalate`: who takes over the undecided part.',
      ),
    escalationDueAfter: durationSchema
      .optional()
      .describe('After an escalation, the request expires after this long.'),
  })
  .strict()
  .superRefine((stage, ctx) => {
    if (stage.onOverdue === 'escalate' && !stage.escalateTo) {
      ctx.addIssue({
        code: 'custom',
        path: ['escalateTo'],
        message: 'onOverdue escalate needs escalateTo',
      });
    }
    if (stage.onOverdue === 'escalate' && !stage.dueAfter) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueAfter'],
        message: 'onOverdue escalate needs dueAfter',
      });
    }
    if (
      stage.remindAfter &&
      stage.dueAfter &&
      millis(stage.remindAfter) >= millis(stage.dueAfter)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['remindAfter'],
        message: 'remindAfter must be shorter than dueAfter',
      });
    }
  });

export const policySchema = z
  .object({
    /** Off: the action needs no approval (an administrator's switch). */
    enabled: z.boolean().default(true),
    when: conditionSchema
      .nullable()
      .optional()
      .describe(
        'Approval is needed only when this holds: `{ "type": "payload", "path": "title", "op": "exists" }`, or `all` / `any` / `not` of others.',
      ),
    stages: z.array(stageSchema).min(1).max(10),
    /** How long the requester has to resubmit after changes were requested. */
    resubmitWithin: durationSchema.default('30d'),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.when && depthOf(policy.when) > 5) {
      ctx.addIssue({
        code: 'custom',
        path: ['when'],
        message: 'conditions nest 5 deep at most',
      });
    }
  });

/** A policy as stored and copied onto requests (defaults filled in). */
export type ApprovalPolicy = z.output<typeof policySchema>;
/** A policy as code declares it (defaults may be left out). */
export type ApprovalPolicyInput = z.input<typeof policySchema>;

/** A policy with its defaults, or a 400 `validation_failed` naming each wrong path (`stages.0.approvers.1.role`). */
export function parsePolicy(input: unknown): ApprovalPolicy {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) throw validationException(parsed.error.issues);
  return parsed.data;
}

/** What policies are made of, with their parameters' JSON Schema (GET /v1/approvals/policy-types). */
export function policyTypes() {
  const view = (schemas: Record<string, z.ZodType>) =>
    Object.entries(schemas).map(([type, schema]) => ({
      type,
      label: schema.description ?? type,
      params: z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }),
    }));
  return {
    approverRules: view(RULES),
    modes: view(MODES),
    conditions: [
      {
        type: 'payload',
        label: 'A value of the proposed change',
        params: z.toJSONSchema(payloadCondition, {
          unrepresentable: 'any',
          io: 'input',
        }),
      },
      { type: 'all', label: 'All of these conditions', params: {} },
      { type: 'any', label: 'Any of these conditions', params: {} },
      { type: 'not', label: 'Not this condition', params: {} },
    ],
  };
}
