import type { AddressInfo } from 'node:net';
import { ConfigModule } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { accessTokenFor, apiClient, signedInUser } from '../../../test/auth.js';
import { accessModules } from '../../../test/access.js';
import { HttpConventionsModule } from '../../core/http/http-conventions.module.js';
import { createHttpAdapter, setupHttp } from '../../core/http/http-setup.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AUTH_EVENTS } from '../../iam/auth/auth.events.js';
// socket.io-client is a devDependency of apps/api (package.json).
import { io, type Socket } from 'socket.io-client';
import { setupRealtime } from './realtime.adapter.js';
import { defineRealtimeEvent } from './realtime.events.js';
import { REALTIME_DISCONNECT_EVENTS } from './realtime.listeners.js';
import { RealtimeModule } from './realtime.module.js';
import { Realtime } from './realtime.service.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-realtime-${process.pid}-${Date.now()}`;
});

const thumbnailReady = defineRealtimeEvent(
  'thumbnail.ready',
  z.object({ fileKey: z.string() }),
);

/** The server bound to a random port, with the socket.io adapter main.ts sets. */
async function boot() {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true }),
      HttpConventionsModule,
      ...accessModules(),
      RealtimeModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestNodeApplication>(
    createHttpAdapter(),
    { logger: false },
  );
  setupHttp(app);
  setupRealtime(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, url: `http://127.0.0.1:${port}/realtime` };
}

/** The arguments of the socket's next `name` event. */
const once = (socket: Socket, name: string) =>
  new Promise<unknown[]>((resolve) => {
    socket.once(name, (...args: unknown[]) => resolve(args));
  });

describe('realtime', () => {
  let app: NestNodeApplication;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    ({ app, url } = await boot());
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      socket.disconnect();
    }
  });

  afterAll(async () => {
    await app.close();
  });

  /** Connects and waits for the answer: the socket, or the handshake's error. */
  async function connect(options: Parameters<typeof io>[1]) {
    const socket = io(url, {
      transports: ['websocket'],
      reconnection: false,
      ...options,
    });
    sockets.push(socket);
    const [outcome] = await Promise.race([
      once(socket, 'connect').then(() => ['connected'] as const),
      once(socket, 'connect_error') as Promise<[Error & { data?: unknown }]>,
    ]);
    return { socket, error: outcome === 'connected' ? undefined : outcome };
  }

  const whoami = (socket: Socket) =>
    socket.emitWithAck('whoami') as Promise<{
      kind: string;
      id: string;
      tenantId: string | null;
      rooms: string[];
    }>;

  /** The next `name` event the socket hears, or null after a short wait. */
  const heard = (socket: Socket, name: string, ms = 1500) =>
    Promise.race([
      once(socket, name).then(([data]) => data as unknown),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);

  it('refuses a connection without credentials at the handshake', async () => {
    const { error } = await connect({});
    expect(error?.message).toBe('unauthorized');
  });

  it("lets a browser in with its session cookie, in its tenant's and its own rooms", async () => {
    const { user, tenantId, headers } = await signedInUser(app);
    const { socket, error } = await connect({ extraHeaders: headers });
    expect(error).toBeUndefined();
    const me = await whoami(socket);
    expect(me).toMatchObject({ kind: 'user', id: user.id, tenantId });
    expect(me.rooms).toEqual(
      expect.arrayContaining([
        `tenant:${tenantId}`,
        `tenant:${tenantId}:principal:user:${user.id}`,
        `principal:user:${user.id}`,
        expect.stringMatching(/^session:/),
      ]),
    );
  });

  it("lets a token client in with its access token, in its family's room", async () => {
    const { user, tenantId } = await signedInUser(app);
    const token = await accessTokenFor(app, user.id, tenantId);
    const { socket, error } = await connect({
      auth: { token: token.accessToken },
    });
    expect(error).toBeUndefined();
    expect((await whoami(socket)).rooms).toEqual(
      expect.arrayContaining([expect.stringMatching(/^token:/)]),
    );
  });

  it("lets an API client in with its key, in its key's room", async () => {
    const { tenantId } = await signedInUser(app);
    const { client, key } = await apiClient(app, tenantId);
    const { socket, error } = await connect({ auth: { token: key } });
    expect(error).toBeUndefined();
    const me = await whoami(socket);
    expect(me).toMatchObject({ kind: 'client', id: client.id, tenantId });
    expect(me.rooms).toEqual(
      expect.arrayContaining([expect.stringMatching(/^key:/)]),
    );
  });

  it("pushes to a principal in the current tenant, to a tenant's sockets, and to nobody else", async () => {
    const realtime = app.get(Realtime);
    const tenancy = app.get(Tenancy);
    const alice = await signedInUser(app);
    const bob = await signedInUser(app, { tenantId: alice.tenantId });
    const other = await signedInUser(app);
    const a = (await connect({ extraHeaders: alice.headers })).socket;
    const b = (await connect({ extraHeaders: bob.headers })).socket;
    const o = (await connect({ extraHeaders: other.headers })).socket;

    const toAlice = heard(a, 'thumbnail.ready');
    const toBob = heard(b, 'thumbnail.ready', 500);
    const toOther = heard(o, 'thumbnail.ready', 500);
    await tenancy.run(alice.tenantId, async () => {
      // Another tenant's user of the same id would still be elsewhere.
      realtime.toPrincipal(
        { kind: 'user', id: alice.user.id },
        thumbnailReady,
        { fileKey: 'one' },
      );
    });
    expect(await toAlice).toEqual({ fileKey: 'one' });
    expect(await toBob).toBeNull();
    expect(await toOther).toBeNull();

    const everyone = [heard(a, 'thumbnail.ready'), heard(b, 'thumbnail.ready')];
    const outsider = heard(o, 'thumbnail.ready', 500);
    await tenancy.run(alice.tenantId, async () => {
      realtime.toTenant(thumbnailReady, { fileKey: 'two' });
    });
    expect(await Promise.all(everyone)).toEqual([
      { fileKey: 'two' },
      { fileKey: 'two' },
    ]);
    expect(await outsider).toBeNull();

    // Outside any tenant: the person's account room, whichever tenant they act in.
    const account = heard(a, 'thumbnail.ready');
    realtime.toPrincipal({ kind: 'user', id: alice.user.id }, thumbnailReady, {
      fileKey: 'three',
    });
    expect(await account).toEqual({ fileKey: 'three' });
  });

  it('refuses a payload off its schema outside production, where it is written', () => {
    expect(() =>
      app
        .get(Realtime)
        .toPrincipal({ kind: 'user', id: 'u1' }, thumbnailReady, {
          fileKey: 1,
        } as never),
    ).toThrow(/thumbnail\.ready/);
  });

  it("ends a session's sockets when the session ends, and only them", async () => {
    const first = await signedInUser(app);
    const second = await signedInUser(app);
    const { socket: s1 } = await connect({ extraHeaders: first.headers });
    const { socket: s2 } = await connect({ extraHeaders: second.headers });
    const sessionId = (await whoami(s1)).rooms
      .find((room) => room.startsWith('session:'))!
      .slice('session:'.length);
    const closed = once(s1, 'disconnect');
    await app
      .get(EventEmitter2)
      .emitAsync(AUTH_EVENTS.sessionEnded, { sessionId });
    expect((await closed)[0]).toBe('io server disconnect');
    expect(s2.connected).toBe(true);
  });

  it("ends a tenant's sockets when it is deactivated, and not another tenant's", async () => {
    const inside = await signedInUser(app);
    const outside = await signedInUser(app);
    const { socket: s1 } = await connect({ extraHeaders: inside.headers });
    const { socket: s2 } = await connect({ extraHeaders: outside.headers });
    const closed = once(s1, 'disconnect');
    await app
      .get(EventEmitter2)
      .emitAsync(REALTIME_DISCONNECT_EVENTS.tenantDeactivated, {
        tenantId: inside.tenantId,
      });
    await closed;
    expect(s2.connected).toBe(true);
  });

  it("ends an API client's sockets when its key is revoked", async () => {
    const { tenantId } = await signedInUser(app);
    const { key } = await apiClient(app, tenantId);
    const { socket } = await connect({ auth: { token: key } });
    const keyId = (await whoami(socket)).rooms
      .find((room) => room.startsWith('key:'))!
      .slice('key:'.length);
    const closed = once(socket, 'disconnect');
    await app
      .get(EventEmitter2)
      .emitAsync(REALTIME_DISCONNECT_EVENTS.keysRevoked, { keyIds: [keyId] });
    await closed;
  });
});
