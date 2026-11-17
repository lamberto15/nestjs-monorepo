import { Logger } from '@nestjs/common';
import {
  CurrentUser,
  type JwtClaims,
  WsAuthenticator,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ConnectedSocket,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { SkipThrottle } from '@nestjs/throttler';
import type { Namespace, Socket } from 'socket.io';
import { ApiKeyAuth } from '../../iam/auth/api-key-auth.provider.js';
import { JwtAuth } from '../../iam/auth/jwt-auth.provider.js';
import { principalKey, type Principal } from '../../iam/auth/principal.js';
import { REALTIME_NAMESPACE } from './realtime.adapter.js';
import {
  keyRoom,
  principalRoom,
  sessionRoom,
  tenantRoom,
  tokenRoom,
} from './realtime.rooms.js';

/**
 * How often an API key's socket asks whether its key still works (revoked,
 * expired, its client or tenant deactivated): what no event reports, such as
 * the end of a rotation's grace period, ends it within this long.
 */
export const KEY_RECHECK_MS = 10 * 60_000;

/** setTimeout's longest delay (2^31 - 1 ms, about 24.8 days); a longer one is armed in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** What the credential's session is, whichever provider made it. */
interface ConnectionSession {
  id?: unknown;
  userId?: unknown;
  sid?: unknown;
  sub?: unknown;
  exp?: unknown;
  method?: unknown;
  keyId?: unknown;
}

/**
 * The connection side of realtime: socket.io, namespace `/realtime`, on
 * every instance (the Redis adapter, realtime.adapter.ts). Pushing is
 * `Realtime` (realtime.service.ts); ending sockets on events is
 * realtime.listeners.ts. README.md has the contract.
 *
 * Authentication runs in socket.io's middleware, before the connection
 * exists, so the client is in its rooms before it hears it's connected and
 * misses nothing sent to it. Anyone else is refused at the handshake
 * (`connect_error` "unauthorized"; socket.io doesn't retry it). The global
 * guard authenticates every message again.
 */
// The rate limit is per HTTP address and its guard reads the HTTP request: it
// can't judge a message.
@SkipThrottle()
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger('Realtime');
  /** Each socket's pending end (or key check): cleared on disconnect. */
  private readonly timers = new WeakMap<Socket, NodeJS.Timeout>();

  constructor(
    private readonly wsAuth: WsAuthenticator,
    private readonly jwtAuth: JwtAuth,
    private readonly apiKeys: ApiKeyAuth,
  ) {}

  afterInit(server: Namespace) {
    server.use((socket, next) => {
      void this.authenticate(socket).then(
        (user) =>
          user
            ? next()
            : next(
                Object.assign(new Error('unauthorized'), {
                  data: { code: 'unauthorized' },
                }),
              ),
        // A failure of ours (a query, the database away): logged here, and
        // the client hears a word only, never the error's text (SQL, hosts).
        (error: unknown) => {
          this.logger.error(
            'Authenticating a realtime connection failed',
            error instanceof Error ? error.stack : String(error),
          );
          next(
            Object.assign(new Error('unavailable'), {
              data: { code: 'unavailable' },
            }),
          );
        },
      );
    });
  }

  private async authenticate(socket: Socket) {
    // An API key (or access token) in the handshake's auth payload becomes the bearer header the providers read.
    const token = (socket.handshake.auth as { token?: unknown }).token;
    if (typeof token === 'string' && !socket.handshake.headers.authorization) {
      socket.handshake.headers.authorization = `Bearer ${token}`;
    }
    // Not required here: the refusal is next(error), a connect_error, rather
    // than a disconnect of a socket that isn't connected yet.
    const result = await this.wsAuth.authenticateConnection(socket, undefined, {
      required: false,
    });
    const user = result?.user as Principal | undefined;
    // Never the system principal (PrincipalGuard's rule, here at the handshake).
    if (!user || user.kind === 'system') {
      return undefined;
    }
    const session = result?.session as ConnectionSession | undefined;
    if (
      user.kind === 'user' &&
      typeof session?.id === 'string' &&
      session.userId === user.id
    ) {
      socket.data.sessionId = session.id;
    }
    // An access token (the session is its claims) of a family revoked since
    // it was issued opens nothing: the revocation that would end this
    // socket has happened already.
    if (
      user.kind === 'user' &&
      typeof session?.sid === 'string' &&
      session.sub === user.id
    ) {
      if (await this.jwtAuth.familyRevoked(session as JwtClaims)) {
        return undefined;
      }
      socket.data.tokenSessionId = session.sid;
    }
    // The token's `exp` is in epoch seconds: the socket ends then.
    if (
      user.kind === 'user' &&
      typeof session?.exp === 'number' &&
      session.sub === user.id
    ) {
      socket.data.tokenExpiresAt = session.exp * 1000;
    }
    if (
      user.kind === 'client' &&
      session?.method === 'api-key' &&
      typeof session.keyId === 'string'
    ) {
      socket.data.keyId = session.keyId;
    }
    socket.data.principal = user;
    return user;
  }

  /** Synchronous: the rooms are joined before the client can send or miss anything. */
  handleConnection(client: Socket) {
    const user = client.data.principal as Principal | undefined;
    if (!user || user.kind === 'system') {
      return;
    }
    const rooms = [
      ...(user.tenantId
        ? [tenantRoom(user.tenantId), principalRoom(user, user.tenantId)]
        : []),
      // The account room (the person's own events, across tenants): never
      // for an administrator acting as them in one tenant.
      ...(user.kind === 'user' && !user.impersonator
        ? [principalRoom(user, null)]
        : []),
    ];
    if (typeof client.data.sessionId === 'string') {
      rooms.push(sessionRoom(client.data.sessionId));
    }
    if (typeof client.data.tokenSessionId === 'string') {
      rooms.push(tokenRoom(client.data.tokenSessionId));
    }
    if (typeof client.data.keyId === 'string') {
      rooms.push(keyRoom(client.data.keyId));
    }
    void client.join(rooms);
    this.logger.debug(`Connected: ${principalKey(user)}`);
    if (typeof client.data.tokenSessionId === 'string') {
      this.recheckFamily(client, user.id, client.data.tokenSessionId);
    }
    if (typeof client.data.tokenExpiresAt === 'number') {
      this.schedule(client, client.data.tokenExpiresAt, () =>
        client.disconnect(true),
      );
    }
    if (typeof client.data.keyId === 'string') {
      this.watchKey(client, client.data.keyId);
    }
  }

  /** A socket that ends has nothing left to time. */
  handleDisconnect(client: Socket) {
    clearTimeout(this.timers.get(client));
    this.timers.delete(client);
  }

  /**
   * Runs `due` at `at` (epoch ms) for this socket, replacing what was
   * pending for it. socket.io has no expiry of its own for a connection's
   * credential ("Handling session expiration" in its how-to on sessions):
   * its way is a timer per socket.
   */
  private schedule(client: Socket, at: number, due: () => void) {
    clearTimeout(this.timers.get(client));
    const delay = at - Date.now();
    if (delay <= 0) {
      this.timers.delete(client);
      due();
      return;
    }
    const timer = setTimeout(
      () => {
        this.timers.delete(client);
        if (client.connected) {
          this.schedule(client, at, due); // due now, or the next step of a long delay
        }
      },
      Math.min(delay, MAX_TIMER_MS),
    );
    // Never what keeps the process alive at shutdown.
    timer.unref();
    this.timers.set(client, timer);
  }

  /**
   * An API key's socket: the key is asked again once the socket is in its
   * room (a revocation in between disconnected nobody), then every
   * KEY_RECHECK_MS, and the socket ends at the key's expiry.
   */
  private watchKey(client: Socket, keyId: string) {
    void this.apiKeys.findKey(keyId).then(
      (record) => {
        if (!client.connected) {
          return;
        }
        if (!record) {
          client.disconnect(true);
          return;
        }
        const next = Date.now() + KEY_RECHECK_MS;
        const expiresAt = record.expiresAt?.getTime();
        if (expiresAt !== undefined && expiresAt <= next) {
          this.schedule(client, expiresAt, () => client.disconnect(true));
        } else {
          this.schedule(client, next, () => this.watchKey(client, keyId));
        }
      },
      (error: unknown) => {
        // Unsure: the socket ends rather than outlive its key.
        this.logger.error(
          "Checking a realtime connection's key failed",
          error instanceof Error ? error.stack : String(error),
        );
        client.disconnect(true);
      },
    );
  }

  /**
   * The handshake asked whether the family was revoked before the socket was
   * in its room: a revocation in between disconnected nobody. Asked again now
   * that it is in the room, so one of the two always sees it.
   */
  private recheckFamily(client: Socket, userId: string, sid: string) {
    void this.jwtAuth.familyRevoked({ sub: userId, sid }).then(
      (revoked) => {
        if (revoked) {
          client.disconnect(true);
        }
      },
      (error: unknown) => {
        // Unsure: the socket ends rather than outlive a revocation.
        this.logger.error(
          'Checking a realtime connection again failed',
          error instanceof Error ? error.stack : String(error),
        );
        client.disconnect(true);
      },
    );
  }

  /** `socket.emitWithAck('whoami')`: who this connection acts as. */
  @Can.Anyone()
  @SubscribeMessage('whoami')
  whoami(@CurrentUser() user: Principal, @ConnectedSocket() client: Socket) {
    return {
      kind: user.kind,
      id: user.id,
      tenantId: user.kind === 'system' ? null : user.tenantId,
      rooms: [...client.rooms].filter((room) => room !== client.id),
    };
  }
}
