import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { IdempotencyEvents } from '@nestjs/idempotency';
import { LocksEvents } from '@nestjs/locks';
import { MailEvents } from '@nestjs/mail';
import { OutboxEvents } from '@nestjs/outbox';
import { ResilienceEvents } from '@nestjs/resilience';
import { WebhooksEvents } from '@nestjs/webhooks';
import { WorkflowEvents } from '@nestjs/workflows';
import { filter, map, merge, type Observable } from 'rxjs';
import { logRedaction, REDACTED } from '../../core/logging/redaction.js';
import { opsEventSchema, type OpsEvent } from './ops.events.schemas.js';

const logger = new Logger('OpsEvents');

/** Every engine whose events the stream carries, by the tag its messages get. */
const SOURCES = {
  workflow: WorkflowEvents,
  webhooks: WebhooksEvents,
  outbox: OutboxEvents,
  idempotency: IdempotencyEvents,
  locks: LocksEvents,
  mail: MailEvents,
  resilience: ResilienceEvents,
} as const;

/** An error of any shape an engine holds, as `{ name?, message }`: never a stack. */
function errorOf(value: unknown): { name?: string; message: string } {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === 'string') return { message: value };
  const { name, message } = (value ?? {}) as {
    name?: unknown;
    message?: unknown;
  };
  if (typeof message === 'string') {
    return typeof name === 'string' ? { name, message } : { message };
  }
  return { message: 'Unknown error' };
}

const SECRET_KEYS = new Set(logRedaction.paths());

/** A value as the logs would show it: secret keys masked, texts scrubbed and cut. */
function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return logRedaction.redactText(value).slice(0, 300);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => scrub(item, depth + 1));
  }
  if (value && typeof value === 'object' && depth < 6) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : scrub(item, depth + 1),
      ]),
    );
  }
  return value;
}

/**
 * One engine's event as the stream sends it: tagged with its `source`, its
 * error reduced to a name and a message, every value scrubbed as the logs
 * are, then checked against `opsEventSchema`, which drops what it does not
 * declare (payloads, headers, outputs). An event the schema refuses (an
 * engine update added a shape) is logged and left out: a dashboard missing
 * one line beats a dropped connection.
 */
export function opsEvent(
  source: OpsEvent['source'],
  event: object,
  at = Date.now(),
): OpsEvent | undefined {
  // The resilience events have a `source` of their own (what the policy guards): it is `origin` here.
  const { source: origin, ...rest } = event as { source?: unknown };
  const tagged: Record<string, unknown> = { at, ...rest, source };
  if (origin !== undefined) tagged.origin = origin;
  if ('error' in tagged && tagged.error != null) {
    tagged.error = errorOf(tagged.error);
  }
  const parsed = opsEventSchema.safeParse(scrub(tagged));
  if (!parsed.success) {
    logger.warn(
      `An ${source} event (${String((event as { type?: unknown }).type)}) does not match the operations schema, left out of the stream: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
    return undefined;
  }
  return parsed.data;
}

/** The live log of the engines the app runs (`GET /v1/ops/events`). */
@Injectable()
export class OpsEventStream {
  constructor(private readonly modules: ModuleRef) {}

  /** The events of every engine this app has, as they happen; an engine the app lacks adds none. */
  stream(): Observable<OpsEvent> {
    const streams: Observable<OpsEvent | undefined>[] = [];
    for (const [source, engine] of Object.entries(SOURCES)) {
      let events: { events$: Observable<object> } | undefined;
      try {
        events = this.modules.get(engine, { strict: false });
      } catch {
        // The app has no such engine (a test boots only some): nothing to add.
      }
      if (events) {
        streams.push(
          events.events$.pipe(
            map((event) => opsEvent(source as OpsEvent['source'], event)),
          ),
        );
      }
    }
    return merge(...streams).pipe(
      filter((event): event is OpsEvent => event !== undefined),
    );
  }
}
