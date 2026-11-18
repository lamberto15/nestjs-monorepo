import { z } from 'zod';
import { listSchema, pageSchema } from '../../core/http/pagination.js';
import { EXPRESSION_LIMITS } from '../expressions/expression.js';

/** At most this many actions per rule: a rule's fan-out is bounded. */
export const MAX_ACTIONS = 5;
/** A simulation looks at this many records at most. */
export const MAX_SIMULATED = 50;

/** An action: its name (GET /v1/automation-rules/subjects) and its parameters. */
const action = z
  .object({
    type: z
      .string()
      .regex(/^[a-z][A-Za-z0-9]*$/)
      .max(50)
      .describe(
        'An action the subject takes: `setField`, `notify`, `webhook`…',
      ),
  })
  .catchall(z.unknown())
  .meta({ example: { type: 'setField', field: 'status', value: 'done' } });

const actions = z.array(action).min(1).max(MAX_ACTIONS);
const trigger = z
  .enum(['created', 'updated'])
  .describe('A record of the subject created, or changed.');
const field = z
  .string()
  .min(1)
  .max(100)
  .nullable()
  .describe('With `updated`: only when this field changed.');
const condition = z
  .string()
  .trim()
  .min(1)
  .max(EXPRESSION_LIMITS.source)
  .nullable()
  .describe(
    "An expression on the record (modules/expressions), true for the records the rule acts on: `status == 'draft' and total > 100`. Null: every record.",
  )
  .meta({ example: "status == 'draft'" });

/** What a rule does: the parts its version counts. */
const definition = {
  subject: z
    .string()
    .min(1)
    .max(100)
    .describe('A subject that takes rules (GET /v1/automation-rules/subjects).')
    .meta({ example: 'Invoice' }),
  trigger,
  field: field.default(null),
  condition: condition.default(null),
  actions,
};

/** Body of `POST /automation-rules`: a draft, until activated. */
export const createAutomationRuleSchema = z.object({
  name: z.string().trim().min(1).max(200).meta({ example: 'Escalate urgent' }),
  ...definition,
});
export type CreateAutomationRuleDto = z.infer<
  typeof createAutomationRuleSchema
>;

/** Body of `PATCH /automation-rules/{id}`: only what is sent changes. */
export const updateAutomationRuleSchema = z.object({
  name: createAutomationRuleSchema.shape.name.optional(),
  trigger: trigger.optional(),
  field: field.optional(),
  condition: condition.optional(),
  actions: actions.optional(),
});
export type UpdateAutomationRuleDto = z.infer<
  typeof updateAutomationRuleSchema
>;

/** Body of `POST /automation-rules/simulate`: a rule's definition, and which records. */
export const simulateAutomationRuleSchema = z.object({
  ...definition,
  recordIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_SIMULATED)
    .optional()
    .describe('These records; default: the most recently changed ones.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SIMULATED)
    .default(20)
    .describe(`Records looked at, at most (${MAX_SIMULATED}).`),
});
export type SimulateAutomationRuleDto = z.infer<
  typeof simulateAutomationRuleSchema
>;

export const automationRuleSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    subject: z.string(),
    trigger: z.enum(['created', 'updated']),
    field: z.string().nullable(),
    condition: z.string().nullable(),
    actions: z.array(action),
    status: z
      .enum(['draft', 'active', 'disabled'])
      .describe(
        'Only an active rule runs; a change of what it does makes it a draft again.',
      ),
    version: z
      .int()
      .describe('Counts the changes of its trigger, condition and actions.'),
    owner: z
      .string()
      .nullable()
      .describe(
        '`user:<id>` of who activated it: it runs with their permissions.',
      ),
    activatedAt: z.iso.datetime().nullable(),
    disabledReason: z
      .string()
      .nullable()
      .describe(
        '`manual`, `owner_inactive`, `run_limit`, `failing`, `subject_gone`.',
      ),
    failures: z.int().describe('Failed runs in a row.'),
    lastRunAt: z.iso.datetime().nullable(),
    lastStatus: z.enum(['succeeded', 'failed']).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'AutomationRule' });

/** One action, as a run (or a simulation) found it. */
export const runActionSchema = z.object({
  type: z.string(),
  allowed: z.boolean(),
  reason: z
    .string()
    .nullable()
    .describe('Why not: `forbidden`, `field_forbidden`, `no_recipient`…'),
  detail: z.string().describe('What it does: `status = "done"`, `2 of 3`…'),
});

export const automationRunSchema = z
  .object({
    id: z.uuid(),
    ruleVersion: z.int(),
    recordId: z.uuid(),
    status: z.enum(['succeeded', 'failed']),
    actions: z.array(runActionSchema),
    error: z
      .string()
      .nullable()
      .describe('`notify: no_recipient`, `condition: division_by_zero`…'),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AutomationRun' });

export const automationRulePageSchema = pageSchema(automationRuleSchema);
export const automationRunPageSchema = pageSchema(automationRunSchema);

export const automationSimulationSchema = z.object({
  subject: z.string(),
  limit: z.int().describe('The sample limit this simulation used.'),
  matched: z.int().describe('Records of the sample the condition holds for.'),
  truncated: z
    .boolean()
    .describe('The limit was reached: other records may match too.'),
  triggerSimulated: z
    .boolean()
    .describe(
      'False with a `field` trigger: records are checked as they are now, as if that field had just changed.',
    ),
  matches: z.array(
    z.object({
      recordId: z.uuid(),
      title: z
        .string()
        .nullable()
        .describe('Its title, when your permissions show it.'),
      actions: z.array(runActionSchema),
    }),
  ),
});
export type AutomationSimulation = z.infer<typeof automationSimulationSchema>;

/** A subject rules may be about. */
export const automationSubjectSchema = z.object({
  subject: z.string().meta({ example: 'Invoice' }),
  path: z.string().meta({ example: 'invoices' }),
  fields: z
    .array(z.string())
    .describe('Fields an `updated` trigger may watch.'),
  variables: z
    .array(z.object({ name: z.string(), type: z.string() }))
    .describe('What a condition may read, with its type.'),
  actions: z
    .array(z.object({ type: z.string() }).catchall(z.unknown()))
    .describe(
      'The actions it takes, with what each says of the subject (`setField`: its `fields`).',
    ),
});
export const automationSubjectListSchema = listSchema(automationSubjectSchema);
