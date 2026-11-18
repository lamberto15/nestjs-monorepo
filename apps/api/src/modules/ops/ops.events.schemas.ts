import { z } from 'zod';

/**
 * One message of `GET /v1/ops/events`: an engine's event, tagged with its
 * `source`. The schema is an allowlist (`z.object()` strips what it does not
 * declare), and it declares no payload, header or workflow output: those may
 * hold a person's data. Times are epoch milliseconds, as the engines keep them.
 */

const epochMs = z.number().int();
const count = z.number().int().nonnegative();
/** A duration: the engines compute backoffs and timings as fractions of a millisecond. */
const ms = z.number().nonnegative();

/** An error as the browser sees it: the class's name and a masked, cut message. */
const errorSchema = z.object({
  name: z.string().optional(),
  message: z.string(),
});

const base = <S extends string>(source: S) => ({
  source: z.literal(source),
  /** Epoch ms of the event. */
  at: epochMs,
});

const outboxMessageSchema = z.object({
  id: z.string(),
  topic: z.string(),
  key: z.string().nullable(),
  createdAt: epochMs,
  availableAt: epochMs,
  attempts: count,
  lastError: z.string().nullable(),
});

const webhookDeliverySchema = z.object({
  id: z.string(),
  messageId: z.string(),
  endpointId: z.string(),
  tenant: z.string().nullable(),
  type: z.string(),
  status: z.enum(['pending', 'succeeded', 'failed']),
  attempts: count,
  nextAttemptAt: epochMs.nullable(),
  lastAttemptAt: epochMs.nullable(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  failureReason: z
    .enum(['exhausted', 'rejected', 'endpoint-disabled', 'endpoint-deleted'])
    .nullable(),
  createdAt: epochMs,
  completedAt: epochMs.nullable(),
});

const workflowBase = (type: string) => ({
  ...base('workflow'),
  type: z.literal(type),
  /** The instance's id. */
  id: z.string(),
  workflow: z.string(),
  version: z.number().int(),
});

const workflowEventSchema = z.discriminatedUnion('type', [
  z.object(workflowBase('workflow-started')),
  z.object({ ...workflowBase('workflow-resumed'), run: count }),
  z.object({
    ...workflowBase('workflow-suspended'),
    wakeAt: epochMs.nullable(),
    waits: z.array(
      z.object({ signal: z.string(), key: z.string().nullable() }),
    ),
  }),
  z.object({ ...workflowBase('workflow-compensating'), error: errorSchema }),
  z.object(workflowBase('workflow-completed')),
  z.object({ ...workflowBase('workflow-failed'), error: errorSchema }),
  z.object({ ...workflowBase('workflow-cancelled'), error: errorSchema }),
  z.object({
    ...workflowBase('workflow-compensation-failed'),
    error: errorSchema,
  }),
  z.object({
    ...workflowBase('step-completed'),
    step: z.string(),
    attempt: count,
    durationMs: ms,
  }),
  z.object({
    ...workflowBase('step-failed'),
    step: z.string(),
    attempt: count,
    error: errorSchema,
    retryAt: epochMs.nullable(),
  }),
  z.object({
    ...workflowBase('step-compensated'),
    step: z.string(),
    attempt: count,
  }),
  z.object({
    ...workflowBase('child-started'),
    child: z.string(),
    childWorkflow: z.string(),
    childVersion: z.number().int(),
  }),
  z.object({
    ...workflowBase('signal-received'),
    wait: z.string(),
    signal: z.string(),
    signalId: z.number().int(),
  }),
  z.object({
    ...workflowBase('signal-timed-out'),
    wait: z.string(),
    signal: z.string(),
  }),
  z.object({
    ...workflowBase('journal-large'),
    entries: count,
    bytes: count,
  }),
  z.object(workflowBase('custom-status')),
  z.object({
    ...workflowBase('workflow-retried'),
    from: z.enum(['failed', 'compensation_failed']),
    error: errorSchema.nullable(),
  }),
  z.object({
    ...workflowBase('workflow-deleted'),
    status: z.string(),
  }),
  z.object({
    ...workflowBase('schedule-skipped'),
    reason: z.enum(['missed', 'overlap']),
    from: epochMs,
    to: epochMs,
  }),
]);

const webhooksEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base('webhooks'),
    type: z.literal('delivered'),
    delivery: webhookDeliverySchema,
    statusCode: z.number().int(),
    attempt: count,
    durationMs: ms,
  }),
  z.object({
    ...base('webhooks'),
    type: z.literal('retry-scheduled'),
    delivery: webhookDeliverySchema,
    error: errorSchema,
    statusCode: z.number().int().nullable(),
    attempt: count,
    delayMs: ms,
  }),
  z.object({
    ...base('webhooks'),
    type: z.literal('delivery-failed'),
    delivery: webhookDeliverySchema,
    error: errorSchema,
    statusCode: z.number().int().nullable(),
    attempt: count,
    reason: z.enum([
      'exhausted',
      'rejected',
      'endpoint-disabled',
      'endpoint-deleted',
    ]),
  }),
  z.object({
    ...base('webhooks'),
    type: z.literal('endpoint-disabled'),
    endpointId: z.string(),
    tenant: z.string().nullable(),
    reason: z.enum(['failing', 'gone']),
  }),
  z.object({
    ...base('webhooks'),
    type: z.literal('destination-blocked'),
    endpointId: z.string(),
    tenant: z.string().nullable(),
    reason: z.string(),
    address: z.string().optional(),
  }),
  z.object({
    ...base('webhooks'),
    type: z.literal('verification-failed'),
    receiver: z.string(),
    reason: z.string(),
  }),
]);

const outboxReason = z.enum(['exhausted', 'rejected']);

const outboxEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base('outbox'),
    type: z.literal('published'),
    message: outboxMessageSchema,
    transport: z.string(),
    durationMs: ms,
  }),
  z.object({
    ...base('outbox'),
    type: z.literal('retry-scheduled'),
    message: outboxMessageSchema,
    transport: z.string().optional(),
    error: errorSchema,
    attempt: count,
    delayMs: ms,
  }),
  z.object({
    ...base('outbox'),
    type: z.literal('dead-lettered'),
    message: outboxMessageSchema,
    transport: z.string().optional(),
    error: errorSchema,
    attempt: count,
    reason: outboxReason,
  }),
  z.object({
    ...base('outbox'),
    type: z.literal('lease-lost'),
    message: outboxMessageSchema,
  }),
]);

const idempotencyBase = {
  ...base('idempotency'),
  context: z.enum(['http', 'graphql', 'rpc']),
  handler: z.string(),
  scope: z.string().optional(),
};

const idempotencyEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...idempotencyBase,
    type: z.literal('replayed'),
    key: z.string(),
    status: z.number().int(),
  }),
  z.object({
    ...idempotencyBase,
    type: z.literal('rejected'),
    key: z.string().optional(),
    code: z.string(),
    status: z.number().int(),
  }),
  z.object({
    ...idempotencyBase,
    type: z.literal('lock-lost'),
    key: z.string(),
    phase: z.enum(['extend', 'complete', 'release']),
  }),
]);

const locksEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base('locks'),
    type: z.literal('lock-lost'),
    key: z.string(),
    fencingToken: z.number().int(),
    detectedBy: z.enum(['renewal', 'deadline']),
  }),
  z.object({
    ...base('locks'),
    type: z.literal('leadership-acquired'),
    key: z.string(),
    fencingToken: z.number().int(),
  }),
  z.object({
    ...base('locks'),
    type: z.literal('leadership-lost'),
    key: z.string(),
    fencingToken: z.number().int(),
    reason: z.enum(['lost', 'released']),
  }),
]);

const mailBase = {
  ...base('mail'),
  messageId: z.string(),
  mail: z.string().optional(),
  recipients: z.array(z.string()),
  subject: z.string(),
  transport: z.string(),
  attempts: count,
  durationMs: ms,
};

const mailEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...mailBase,
    type: z.literal('sent'),
    providerMessageId: z.string().optional(),
  }),
  z.object({
    ...mailBase,
    type: z.literal('failed'),
    error: errorSchema,
    permanent: z.boolean(),
  }),
]);

const resilienceBase = {
  ...base('resilience'),
  policy: z.string(),
  /** What the policy guards, when it says (the event's own `source`). */
  origin: z.string().optional(),
};

const circuitState = z.enum(['closed', 'open', 'half-open']);

const resilienceEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...resilienceBase,
    type: z.literal('retry'),
    attempt: count,
    delayMs: ms,
    error: errorSchema,
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('timeout'),
    timeoutMs: ms,
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('circuit-open'),
    from: circuitState,
    to: z.literal('open'),
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('circuit-half-open'),
    from: circuitState,
    to: z.literal('half-open'),
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('circuit-closed'),
    from: circuitState,
    to: z.literal('closed'),
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('circuit-rejected'),
    retryAfterMs: ms,
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('bulkhead-rejected'),
    reason: z.enum(['full', 'queue-timeout']),
    active: count,
    queued: count,
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('rate-limited'),
    retryAfterMs: ms,
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('fallback'),
    error: errorSchema,
  }),
]);

/**
 * The `data` of one message of the stream: the engine's event, tagged with
 * its `source`. Narrow by `source`, then by `type`.
 */
export const opsEventSchema = z.union([
  workflowEventSchema,
  webhooksEventSchema,
  outboxEventSchema,
  idempotencyEventSchema,
  locksEventSchema,
  mailEventSchema,
  resilienceEventSchema,
]);

export type OpsEvent = z.infer<typeof opsEventSchema>;
