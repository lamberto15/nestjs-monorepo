import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  Outbox,
  OnOutboxMessage,
  type OutboxHandlerContext,
} from '@nestjs/outbox';
import type { DatabaseTransactions } from '../database/database.js';
import { currentTenantScope } from '../tenancy/tenant-scope.js';
import { inTenantOf } from '../tenancy/tenant-job.js';

/**
 * A domain event type, with its payload: `defineEvent<{ noteId: string }>('note.published')`.
 * The module that owns the event exports it; subscribers import it from
 * there, so there is no central list of events.
 */
export interface DomainEvent<P> {
  /** `note.published`: full-stop delimited segments. */
  readonly type: string;
  /** Carries the payload type only. */
  readonly payload?: P;
}

const EVENT_TYPE = /^[a-z][\w-]*(\.[\w-]+)+$/;

export function defineEvent<P>(type: string): DomainEvent<P> {
  if (!EVENT_TYPE.test(type)) {
    throw new TypeError(
      `"${type}" is not an event type: lowercase, full-stop delimited segments, as in note.published.`,
    );
  }
  return { type };
}

/**
 * The event types something subscribes to (`@OnDomainEvent`), known once
 * the modules are loaded, the same in the API and the worker. An event
 * nobody subscribes to is not written: the outbox retries a message without
 * a handler and holds back the later ones of its key, so one unheard
 * `note.created` would delay the `note.updated` a webhook waits for.
 */
const subscribed = new Set<string>();

/** The tenant an event was published in, in the outbox message's headers. */
const TENANT_HEADER = 'tenantId';

/**
 * Publishes domain events through the outbox: the event is written in the
 * transaction of the change that caused it (`@Transactional()`), so it is
 * delivered if and only if the change commits. The relay delivers it within
 * a second, in the worker process.
 */
@Injectable()
export class Events {
  constructor(
    private readonly outbox: Outbox,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
  ) {}

  /**
   * `key` orders events: those with the same key are delivered one at a
   * time, in the order they were published (a record's id keeps its events in order).
   */
  async publish<P>(
    event: DomainEvent<P>,
    payload: P,
    { key }: { key?: string } = {},
  ) {
    // The outbox refuses the database itself (its write would commit alone),
    // but only with its own message: say what to do.
    if (!this.txHost.isTransactionActive()) {
      throw new Error(
        `Publish ${event.type} inside the transaction of the change (@Transactional()): it must commit or roll back with it.`,
      );
    }
    if (!subscribed.has(event.type)) {
      return;
    }
    const tenantId = currentTenantScope()?.tenantId;
    await this.outbox.add(this.txHost.tx, {
      topic: event.type,
      payload,
      key,
      headers: tenantId ? { [TENANT_HEADER]: tenantId } : {},
    });
  }
}

/**
 * Runs the method for every `event`, in the worker, in the tenant it was
 * published in. `consumer` names the method's inbox (@nestjs/outbox): an
 * event delivered twice runs it once. Keep it stable across renames. A
 * method that writes data uses `ctx.processInTransaction(tx, work)` to make
 * its effects exactly once.
 *
 * Custom code over `@OnOutboxMessage()`: the package has no hook to run a
 * handler in a context, so the method is wrapped to restore the tenant first.
 */
export function OnDomainEvent<P>(
  event: DomainEvent<P>,
  options: { consumer: string },
) {
  return <M extends (payload: P, ctx: OutboxHandlerContext) => unknown>(
    _target: object,
    _key: string | symbol,
    descriptor: TypedPropertyDescriptor<M>,
  ) => {
    const handler = descriptor.value!;
    descriptor.value = function (
      this: unknown,
      payload: P,
      ctx: OutboxHandlerContext,
    ) {
      const tenantId = ctx.message.headers[TENANT_HEADER] ?? null;
      return inTenantOf({ tenantId }, async () =>
        handler.call(this, payload, ctx),
      );
    } as M;
    subscribed.add(event.type);
    OnOutboxMessage(event.type, options)(_target, _key, descriptor);
  };
}
