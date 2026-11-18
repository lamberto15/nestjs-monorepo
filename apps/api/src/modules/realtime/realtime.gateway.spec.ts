import type { WsAuthenticator } from '@nestjs/authentication';
import type { Namespace, Socket } from 'socket.io';
import type { ApiKeyAuth } from '../../iam/auth/api-key-auth.provider.js';
import type { DrizzleAuthenticationStore } from '../../iam/auth/drizzle-authentication.store.js';
import type { JwtAuth } from '../../iam/auth/jwt-auth.provider.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { SessionAuth } from '../../iam/auth/session-auth.provider.js';
import { SessionLifetime } from '../../iam/auth/session-lifetime.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { tokenRoom } from './realtime.rooms.js';

describe('RealtimeGateway and token families', () => {
  const principal = {
    kind: 'user',
    id: 'u1',
    tenantId: 't1',
  } as unknown as Principal;

  /** A gateway whose handshake middleware and joined rooms the test reads. */
  function gateway(session: object, revoked = false) {
    const familyRevoked = vi.fn().mockResolvedValue(revoked);
    const authenticateConnection = vi
      .fn()
      .mockResolvedValue({ user: principal, session });
    const gateway = new RealtimeGateway(
      { authenticateConnection } as unknown as WsAuthenticator,
      { familyRevoked } as unknown as JwtAuth,
      {} as ApiKeyAuth,
      {} as DrizzleAuthenticationStore,
      {} as SessionLifetime,
      {} as SessionAuth,
    );
    let middleware:
      ((socket: Socket, next: (error?: Error) => void) => void) | undefined;
    gateway.afterInit({
      use: (fn: typeof middleware) => (middleware = fn),
    } as unknown as Namespace);

    /** The handshake, then the connection: the error, or the rooms joined. */
    const connect = async () => {
      const join = vi.fn();
      const disconnect = vi.fn();
      const socket = {
        handshake: { auth: { token: 'a.b.c' }, headers: {} },
        data: {},
        join,
        disconnect,
      } as unknown as Socket;
      const error = await new Promise<Error | undefined>((resolve) =>
        middleware!(socket, resolve),
      );
      if (error) {
        return { error };
      }
      gateway.handleConnection(socket);
      // The check after the join settles.
      await new Promise((resolve) => setImmediate(resolve));
      return { rooms: join.mock.calls[0]?.[0] as string[], disconnect };
    };
    return { familyRevoked, connect };
  }

  it("puts a token client's socket in its family's room", async () => {
    const { connect, familyRevoked } = gateway({ sub: 'u1', sid: 'family-1' });
    const { rooms } = await connect();
    expect(familyRevoked).toHaveBeenCalledWith({ sub: 'u1', sid: 'family-1' });
    expect(rooms).toContain(tokenRoom('family-1'));
  });

  it('refuses the access token of a revoked family at the handshake', async () => {
    const { connect } = gateway({ sub: 'u1', sid: 'family-1' }, true);
    expect((await connect()).error?.message).toBe('unauthorized');
  });

  it("joins no family room for a token without a sid, or another user's", async () => {
    for (const session of [{ sub: 'u1' }, { sub: 'u2', sid: 'family-1' }]) {
      const { connect, familyRevoked } = gateway(session);
      const { rooms } = await connect();
      expect(familyRevoked).not.toHaveBeenCalled();
      expect(rooms!.some((room) => room.startsWith('token:'))).toBe(false);
    }
  });

  it('disconnects a socket whose family was revoked between the check and the join', async () => {
    const { connect, familyRevoked } = gateway({ sub: 'u1', sid: 'family-1' });
    // The handshake's check: live. The one after the join: revoked meanwhile.
    familyRevoked.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { disconnect } = await connect();
    expect(familyRevoked).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('keeps a socket whose family is still live after the join', async () => {
    const { connect } = gateway({ sub: 'u1', sid: 'family-1' });
    const { disconnect } = await connect();
    expect(disconnect).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway and browser sessions', () => {
  const IDLE_MS = 30 * 60_000;
  const MAX_MS = 8 * 3_600_000;
  const principal = {
    kind: 'user',
    id: 'u1',
    tenantId: 't1',
  } as unknown as Principal;

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-11-19T09:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A session as the store keeps it, last used at `lastActiveAt`; an
   * impersonation's when it carries an `impersonator` ending at `endsAt`.
   */
  const stored = (lastActiveAt: number, endsAt?: number) => ({
    id: 's1',
    userId: 'u1',
    createdAt: new Date(Date.parse('2026-11-19T08:00:00Z')),
    expiresAt: new Date(Date.parse('2026-11-26T08:00:00Z')),
    lastActiveAt: new Date(lastActiveAt),
    extra: { previousActiveAt: new Date(lastActiveAt) },
    ...(endsAt !== undefined && {
      metadata: {
        tenantId: 't1',
        impersonator: {
          id: 'admin',
          tenantId: 't1',
          endsAt: new Date(endsAt).toISOString(),
        },
      },
    }),
  });

  /**
   * A gateway over a session store and the lifetime rule as the app has
   * them (the tenant's idle and maximum, from SessionLifetime's own code),
   * with SessionAuth's answer (`revalidate`: accepted by default).
   */
  async function connected(
    getSession: ReturnType<typeof vi.fn>,
    {
      endsAt,
      revalidate = vi.fn().mockResolvedValue(principal),
    }: { endsAt?: number; revalidate?: ReturnType<typeof vi.fn> } = {},
  ) {
    const lifetime = new SessionLifetime(
      {
        sessionLimits: () =>
          Promise.resolve({ idleMs: IDLE_MS, maxMs: MAX_MS, chosen: {} }),
      } as never,
      {} as never,
    );
    const gateway = new RealtimeGateway(
      {
        authenticateConnection: vi.fn().mockResolvedValue({
          user:
            endsAt === undefined
              ? principal
              : { ...principal, impersonator: { id: 'admin' } },
          session: stored(Date.now(), endsAt),
        }),
      } as unknown as WsAuthenticator,
      {} as JwtAuth,
      {} as ApiKeyAuth,
      { getSession } as unknown as DrizzleAuthenticationStore,
      lifetime,
      { revalidate } as unknown as SessionAuth,
    );
    let middleware:
      ((socket: Socket, next: (error?: Error) => void) => void) | undefined;
    gateway.afterInit({
      use: (fn: typeof middleware) => (middleware = fn),
    } as unknown as Namespace);
    const disconnect = vi.fn();
    const socket = {
      handshake: { auth: {}, headers: { host: 'app.example.com' } },
      data: {},
      join: vi.fn(),
      disconnect,
      connected: true,
    } as unknown as Socket;
    await new Promise((resolve) => middleware!(socket, resolve));
    gateway.handleConnection(socket);
    return { disconnect };
  }

  it('ends a passive socket when its session times out idle, without touching it', async () => {
    const connectedAt = Date.now();
    const getSession = vi.fn().mockResolvedValue(stored(connectedAt));
    const { disconnect } = await connected(getSession);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);
    expect(getSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(getSession).toHaveBeenCalledWith('s1');
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('keeps a socket whose session was used meanwhile, until the moved deadline', async () => {
    const connectedAt = Date.now();
    const usedAt = connectedAt + 20 * 60_000;
    const getSession = vi.fn().mockResolvedValue(stored(usedAt));
    const { disconnect } = await connected(getSession);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(usedAt + IDLE_MS - Date.now());
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('ends the socket at the deadline when the session is gone (a prune)', async () => {
    const { disconnect } = await connected(
      vi.fn().mockResolvedValue(undefined),
    );
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('ends the socket at the deadline when SessionAuth no longer accepts the session', async () => {
    const session = stored(Date.now());
    const revalidate = vi.fn().mockResolvedValue(null); // e.g. the membership ended
    const { disconnect } = await connected(vi.fn().mockResolvedValue(session), {
      revalidate,
    });
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(revalidate).toHaveBeenCalledWith(session, 'app.example.com');
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it("ends an impersonation's socket at its end, before the session's idle timeout", async () => {
    const endsAt = Date.now() + 10 * 60_000;
    const getSession = vi.fn().mockResolvedValue(stored(Date.now(), endsAt));
    // As SessionAuth answers past the impersonation's end.
    const revalidate = vi.fn().mockResolvedValue(null);
    const { disconnect } = await connected(getSession, { endsAt, revalidate });
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1000);
    expect(getSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it("asks an impersonation's rules at the idle deadline, and ends it at its end however used", async () => {
    const connectedAt = Date.now();
    const endsAt = connectedAt + 45 * 60_000;
    const usedAt = connectedAt + 20 * 60_000;
    const getSession = vi.fn().mockResolvedValue(stored(usedAt, endsAt));
    const revalidate = vi.fn().mockResolvedValue(principal);
    const { disconnect } = await connected(getSession, { endsAt, revalidate });
    // The idle deadline: still accepted, used since; the next one is its end.
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(endsAt - Date.now() - 1000);
    expect(revalidate).toHaveBeenCalledTimes(1);
    // Accepted or not, a deadline past is the end (the package's expiry included).
    await vi.advanceTimersByTimeAsync(1000);
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it("ends an impersonation's socket at the idle deadline when its rule no longer holds", async () => {
    const endsAt = Date.now() + 45 * 60_000;
    const revalidate = vi.fn().mockResolvedValue(null); // a role changed
    const { disconnect } = await connected(
      vi.fn().mockResolvedValue(stored(Date.now(), endsAt)),
      { endsAt, revalidate },
    );
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(disconnect).toHaveBeenCalledWith(true);
  });
});
