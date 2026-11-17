import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { REDIS } from '../../core/redis/redis.js';
import {
  currentTenantScope,
  requireTenantId,
} from '../../core/tenancy/tenant-scope.js';
import type { Principal } from '../../iam/auth/principal.js';
import { channelKey, REALTIME_NAMESPACE } from './realtime.adapter.js';
import { payloadProblem, type RealtimeEvent } from './realtime.events.js';
import { principalRoom, tenantRoom } from './realtime.rooms.js';

type PrincipalRef = Pick<Principal, 'kind' | 'id'>;

/**
 * Pushes events to connected sockets (README.md). It publishes on Redis
 * through socket.io's emitter, on the channels every instance's Redis adapter
 * listens to, so it works from any process: an API instance, and the worker,
 * which has no socket server (outbox subscribers run there). Push after the
 * change committed, so a client never hears of one that rolled back; a push
 * is best-effort, never worth failing a request.
 */
@Injectable()
export class Realtime implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Realtime');
  private readonly emitter: Emitter;
  /** Set when the app begins to close, before Redis does: a late push is dropped, not rejected. */
  private closing = false;

  constructor(@Inject(REDIS) redis: Redis) {
    this.emitter = new Emitter(redis, { key: channelKey(redis) }).of(
      `/${REALTIME_NAMESPACE}`,
    );
  }

  /**
   * To every connection of a user or an API client in the current context's
   * tenant (a request's, an event handler's); outside any tenant, to a
   * user's account room (an API client always has a tenant: nothing to tell
   * outside one).
   */
  toPrincipal<S extends z.ZodType>(
    principal: PrincipalRef,
    event: RealtimeEvent<S>,
    data: z.infer<S>,
  ) {
    this.toPrincipals([principal], event, data);
  }

  /** As `toPrincipal`, to several at once (a record's watchers). The system principal is skipped: it never connects. */
  toPrincipals<S extends z.ZodType>(
    principals: Iterable<PrincipalRef>,
    event: RealtimeEvent<S>,
    data: z.infer<S>,
  ) {
    const tenantId = currentTenantScope()?.tenantId ?? null;
    const rooms = new Set<string>();
    for (const principal of principals) {
      if (
        principal.kind === 'system' ||
        (!tenantId && principal.kind !== 'user')
      ) {
        continue;
      }
      rooms.add(principalRoom(principal, tenantId));
    }
    this.emit([...rooms], event, data);
  }

  /** To every connection acting in the current context's tenant. */
  toTenant<S extends z.ZodType>(event: RealtimeEvent<S>, data: z.infer<S>) {
    this.emit(
      [tenantRoom(requireTenantId('Realtime.toTenant()'))],
      event,
      data,
    );
  }

  /** Ends the sockets in these rooms, on every instance (and closes them). */
  disconnect(rooms: string[]) {
    if (rooms.length > 0 && !this.closing) {
      this.emitter.in(rooms).disconnectSockets(true);
    }
  }

  /** Nest calls it before it closes Redis. */
  beforeApplicationShutdown() {
    this.closing = true;
  }

  private emit(rooms: string[], event: RealtimeEvent, data: unknown) {
    // Development and tests: a payload off its schema is a bug in the caller,
    // so it fails where it is written. Production sends what it is given.
    if (process.env.NODE_ENV !== 'production') {
      const problem = payloadProblem(event, data);
      if (problem) {
        throw new Error(problem);
      }
    }
    if (rooms.length === 0 || this.closing) {
      return;
    }
    try {
      this.emitter.to(rooms).emit(event.name, data);
    } catch (error) {
      this.logger.warn(`${event.name} was not pushed: ${String(error)}`);
    }
  }
}
