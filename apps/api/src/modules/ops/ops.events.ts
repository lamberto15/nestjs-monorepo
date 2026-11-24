import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { IdempotencyEvents } from '@nestjs/idempotency';
import { LocksEvents } from '@nestjs/locks';
import { MailEvents } from '@nestjs/mail';
import { OutboxEvents } from '@nestjs/outbox';
import { ResilienceEvents } from '@nestjs/resilience';
import { WebhooksEvents } from '@nestjs/webhooks';
import { WorkflowEvents } from '@nestjs/workflows';
import type { Redis } from 'ioredis';
import {
  defer,
  finalize,
  merge,
  type Observable,
  Subject,
  type Subscription,
  takeUntil,
  timer,
} from 'rxjs';
import { closeRedis, REDIS } from '../../core/redis/redis.js';
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

/**
 * How long one stream stays open. The browser's EventSource reconnects by
 * itself, through sign-in and `@Can()` again: a revoked session, key or
 * permission loses the stream within this long, on whichever instance it
 * was opened.
 */
export const OPS_STREAM_MAX_MS = 5 * 60_000;

/** After a publish no instance listened to, how long this one stops publishing. */
const QUIET_MS = 5000;

/**
 * The live log of the engines (`GET /v1/ops/events`), from every instance:
 * each publishes its engines' events to one Redis channel, and each stream
 * reads the channel, so an API instance shows what the worker's outbox,
 * workflows and mail do. While no instance watches (a publish reaches no
 * subscriber), an instance stops publishing for a few seconds, so the
 * engines cost nothing when nobody looks.
 */
@Injectable()
export class OpsEventStream
  implements OnModuleInit, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly local: Subscription[] = [];
  private readonly received = new Subject<OpsEvent>();
  private readonly closing = new Subject<void>();
  private subscriber?: Redis;
  private watchers = 0;
  private quietUntil = 0;

  constructor(
    private readonly modules: ModuleRef,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private get channel() {
    return `${this.redis.options.keyPrefix ?? ''}ops:events`;
  }

  onModuleInit() {
    for (const [source, engine] of Object.entries(SOURCES)) {
      let events: { events$: Observable<object> } | undefined;
      try {
        events = this.modules.get(engine, { strict: false });
      } catch {
        // The app has no such engine (a test boots only some): nothing to add.
      }
      if (events) {
        this.local.push(
          events.events$.subscribe((event) =>
            this.publish(source as OpsEvent['source'], event),
          ),
        );
      }
    }
  }

  private publish(source: OpsEvent['source'], event: object) {
    if (Date.now() < this.quietUntil) return;
    const tagged = opsEvent(source, event);
    if (!tagged) return;
    this.redis.publish(this.channel, JSON.stringify(tagged)).then(
      (listeners) => {
        if (listeners === 0) this.quietUntil = Date.now() + QUIET_MS;
      },
      () => undefined,
    );
  }

  /** The events of every instance, as they happen, for OPS_STREAM_MAX_MS at most. */
  stream(): Observable<OpsEvent> {
    return defer(() => {
      this.watch();
      return this.received;
    }).pipe(
      takeUntil(merge(timer(OPS_STREAM_MAX_MS), this.closing)),
      finalize(() => this.unwatch()),
    );
  }

  private watch() {
    if (this.watchers++ > 0) return;
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', (error: Error) =>
      logger.warn(`Ops events: ${error.message}`),
    );
    this.subscriber.on('message', (_channel: string, message: string) => {
      let parsed;
      try {
        parsed = opsEventSchema.safeParse(JSON.parse(message));
      } catch {
        return;
      }
      if (parsed.success) this.received.next(parsed.data);
    });
    void this.subscriber
      .subscribe(this.channel)
      .catch((error: unknown) =>
        logger.warn(`Ops events: subscribing failed: ${String(error)}`),
      );
  }

  private unwatch() {
    if (--this.watchers > 0 || !this.subscriber) return;
    void closeRedis(this.subscriber);
    this.subscriber = undefined;
  }

  /** Open streams end before the HTTP server closes, or they would hold it open. */
  beforeApplicationShutdown() {
    this.closing.next();
  }

  onApplicationShutdown() {
    for (const subscription of this.local) subscription.unsubscribe();
  }
}
