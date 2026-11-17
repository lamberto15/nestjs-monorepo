import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { Test } from '@nestjs/testing';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { HttpConventionsModule } from '../../core/http/http-conventions.module.js';
import { createHttpAdapter, setupHttp } from '../../core/http/http-setup.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AccessRecordFinder } from '../../iam/access/access-record-finder.js';
import { definePermissions } from '../../iam/access/permissions.js';
// socket.io-client is a devDependency of apps/api (package.json).
import {
  io,
  type Socket,
} from '../../../../../node_modules/.pnpm/socket.io-client@4.8.4_supports-color@7.2.0/node_modules/socket.io-client/build/esm/index.js';
import { setupRealtime } from '../realtime/realtime.adapter.js';
import { PresenceModule } from './presence.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-presence-${process.pid}-${Date.now()}`;
});

const RECORD = randomUUID();

/** A subject with one record, readable by whoever holds Note.read. */
@Injectable()
@AccessRecordFinder('Note')
class NoteFinder {
  find(id: string) {
    return Promise.resolve(id === RECORD ? { id } : null);
  }
}

@Module({
  imports: [
    AccessModule.forFeature(
      definePermissions({
        subjects: { Note: { actions: { read: [] } } },
        seedRoles: [
          {
            key: 'viewer',
            permissions: [{ subject: 'Note', action: 'read', conditions: [] }],
          },
        ],
      }),
    ),
  ],
  providers: [NoteFinder],
})
class NotesModule {}

describe('presence (e2e)', () => {
  let app: NestNodeApplication;
  let url: string;
  let tenantId: string;
  let reader: { id: string; headers: Record<string, string> };
  let other: { id: string; headers: Record<string, string> };
  let outsider: { headers: Record<string, string> };
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        HttpConventionsModule,
        ...accessModules(),
        NotesModule,
        PresenceModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestNodeApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    setupHttp(app);
    setupRealtime(app);
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    url = `http://127.0.0.1:${port}/realtime`;
    ({ tenantId } = await tenantWithAdmin(app));
    reader = await member(app, tenantId, ['viewer'], { name: 'Rita Reader' });
    other = await member(app, tenantId, ['viewer'], { name: 'Otto Other' });
    outsider = await member(app, tenantId, [], { name: 'Out Sider' });
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await app.close();
  });

  const path = (subject = 'Note', id = RECORD) =>
    `/v1/presence/${subject}/${id}`;
  const beat = (headers: Record<string, string>, mode = 'viewing') =>
    app.inject({ method: 'PUT', url: path(), headers, payload: { mode } });

  it('lists who is on a record, with who you are', async () => {
    const first = await beat(reader.headers);
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toEqual([
      {
        key: `user:${reader.id}`,
        name: 'Rita Reader',
        mode: 'viewing',
        self: true,
      },
    ]);
    const second = await beat(other.headers, 'editing');
    expect(second.json().items).toHaveLength(2);
    const seen = await app.inject({
      method: 'GET',
      url: path(),
      headers: reader.headers,
    });
    expect(seen.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Otto Other',
          mode: 'editing',
          self: false,
        }),
      ]),
    );
  });

  it('tells those on the record when someone arrives or leaves, ids only', async () => {
    const socket = io(url, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: reader.headers,
    });
    sockets.push(socket);
    await new Promise((resolve) =>
      socket.once('connect', () => resolve(undefined)),
    );
    await beat(reader.headers);
    const left = new Promise((resolve) =>
      socket.once('record.presence', resolve),
    );
    const gone = await app.inject({
      method: 'DELETE',
      url: path(),
      headers: other.headers,
    });
    expect(gone.statusCode).toBe(204);
    expect(await left).toEqual({ subject: 'Note', recordId: RECORD });
    const list = await app.inject({
      method: 'GET',
      url: path(),
      headers: reader.headers,
    });
    expect(
      list.json().items.map((item: { name: string }) => item.name),
    ).toEqual(['Rita Reader']);
  });

  it("answers 404 to someone who may not read the record, or for a record or subject that isn't there", async () => {
    for (const request of [
      { headers: outsider.headers, url: path() },
      { headers: reader.headers, url: path('Note', randomUUID()) },
      { headers: reader.headers, url: path('Nothing') },
    ]) {
      const response = await app.inject({ method: 'GET', ...request });
      expect(response.statusCode).toBe(404);
    }
  });

  it('refuses a mode that is neither viewing nor editing', async () => {
    const response = await beat(reader.headers, 'typing');
    expect(response.statusCode).toBe(400);
  });
});
