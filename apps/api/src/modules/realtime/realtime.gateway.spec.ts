import type { WsAuthenticator } from '@nestjs/authentication';
import type { Namespace, Socket } from 'socket.io';
import type { ApiKeyAuth } from '../../iam/auth/api-key-auth.provider.js';
import type { JwtAuth } from '../../iam/auth/jwt-auth.provider.js';
import type { Principal } from '../../iam/auth/principal.js';
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
