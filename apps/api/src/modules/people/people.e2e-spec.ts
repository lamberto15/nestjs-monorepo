import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { apiClient } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { userAvatars } from '../attachments/avatars/avatars.tables.js';
import { PeopleModule } from './people.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-people-${process.pid}-${Date.now()}`;
});

interface Person {
  key: string;
  name: string;
  avatarUrl: string | null;
}

describe('people (e2e)', () => {
  let app: NestNodeApplication;
  let t: Awaited<ReturnType<typeof tenantWithAdmin>>;

  beforeAll(async () => {
    app = await bootModules(...accessModules(), PeopleModule);
    t = await tenantWithAdmin(app);
  });
  afterAll(() => app.close());

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });
  const tag = () => randomUUID().slice(0, 6);
  const named = (name: string) => member(app, t.tenantId, [], { name });

  describe('GET /v1/people', () => {
    it('lets any member find the active members by part of their name: key and name only', async () => {
      const x = tag();
      const maya = await named(`Maya ${x} Patel`);
      const mark = await named(`Mark ${x} Mayall`);
      const plain = await named(`Plain ${x}`);
      await app
        .get<Database>(getDrizzleToken())
        .insert(userAvatars)
        .values({ userId: mark.id, key: `accounts/${mark.id}/avatar/a.png` });

      const found = await get('/v1/people?q=MAY&limit=20', plain.headers);
      expect(found.statusCode).toBe(200);
      const ours = (found.json().items as Person[]).filter((p) =>
        p.name.includes(x),
      );
      expect(ours).toEqual([
        {
          key: `user:${mark.id}`,
          name: `Mark ${x} Mayall`,
          avatarUrl: expect.stringMatching(
            `^/v1/people/${mark.id}/avatar\\?v=`,
          ),
        },
        { key: `user:${maya.id}`, name: `Maya ${x} Patel`, avatarUrl: null },
      ]);

      // `%` and `_` are themselves, not wildcards.
      expect(
        (await get('/v1/people?q=%25', plain.headers)).json().items,
      ).toEqual([]);

      // A deactivated membership leaves the directory.
      const off = await app.inject({
        method: 'PATCH',
        url: `/v1/access/users/${mark.id}`,
        headers: t.admin.headers,
        payload: { active: false },
      });
      expect(off.statusCode).toBe(204);
      const after = await get(`/v1/people?q=${x}`, plain.headers);
      expect((after.json().items as Person[]).map((p) => p.key)).toEqual([
        `user:${maya.id}`,
        `user:${plain.id}`,
      ]);
    });

    it("never shows another tenant's people", async () => {
      const x = tag();
      const other = await tenantWithAdmin(app);
      const theirs = await member(app, other.tenantId, [], {
        name: `Theirs ${x}`,
      });
      const plain = await named(`Viewer ${x}`);
      expect(
        (await get(`/v1/people?q=Theirs`, plain.headers)).json().items,
      ).toEqual([]);
      const back = await get(`/v1/people?q=${x}`, theirs.headers);
      expect((back.json().items as Person[]).map((p) => p.key)).not.toContain(
        `user:${plain.id}`,
      );
    });

    it('validates the query (400) and is for users only', async () => {
      const plain = await named(`Checker ${tag()}`);
      for (const query of [
        'limit=21',
        'limit=0',
        `q=${'x'.repeat(101)}`,
        'x=1',
      ]) {
        const res = await get(`/v1/people?${query}`, plain.headers);
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('validation_failed');
      }
      const client = await apiClient(app, t.tenantId);
      expect((await get('/v1/people', client.headers)).statusCode).toBe(401);
      expect((await get('/v1/people')).statusCode).toBe(401);
    });

    it('names members, former members and API clients of the tenant, in the order asked; anything else is left out', async () => {
      const x = tag();
      const maya = await named(`Maya ${x}`);
      const gone = await named(`Gone ${x}`);
      const plain = await named(`Plain ${x}`);
      const robot = await apiClient(app, t.tenantId, { name: `Robot ${x}` });
      await app.inject({
        method: 'PATCH',
        url: `/v1/access/users/${gone.id}`,
        headers: t.admin.headers,
        payload: { active: false },
      });
      const other = await tenantWithAdmin(app);
      const theirs = await member(app, other.tenantId, []);
      const keys = [
        `user:${gone.id}`,
        `client:${robot.client.id}`,
        `user:${theirs.id}`,
        `user:${randomUUID()}`,
        `user:${maya.id}`,
        `user:${gone.id}`,
      ];
      const res = await get(`/v1/people?key=${keys.join(',')}`, plain.headers);
      // A deactivated member keeps their name (they still own records);
      // another tenant's user, or no one, is simply absent.
      expect(res.json().items).toEqual([
        { key: `user:${gone.id}`, name: `Gone ${x}`, avatarUrl: null },
        {
          key: `client:${robot.client.id}`,
          name: `Robot ${x}`,
          avatarUrl: null,
        },
        { key: `user:${maya.id}`, name: `Maya ${x}`, avatarUrl: null },
      ]);
      // And the other tenant can't name ours.
      const back = await get(`/v1/people?key=user:${maya.id}`, theirs.headers);
      expect(back.json().items).toEqual([]);
    });

    it('validates the keys (400): their form, at most 20, not with q', async () => {
      const plain = await named(`Keys ${tag()}`);
      const many = Array.from({ length: 21 }, () => `user:${randomUUID()}`);
      for (const query of [
        'key=',
        `key=${randomUUID()}`,
        'key=user:not-a-uuid',
        `key=system:${randomUUID()}`,
        `key=${many.join(',')}`,
        `q=may&key=user:${randomUUID()}`,
      ]) {
        const res = await get(`/v1/people?${query}`, plain.headers);
        expect(res.statusCode).toBe(400);
      }
      expect(
        (
          await get(
            `/v1/people?key=${many.slice(0, 20).join(',')}`,
            plain.headers,
          )
        ).statusCode,
      ).toBe(200);
    });
  });

  describe('GET /v1/organizational-units', () => {
    interface UnitRef {
      id: string;
      parentId: string | null;
      depth: number;
      name: string;
    }
    const unit = async (
      headers: Record<string, string>,
      name: string,
      parentId?: string,
    ) => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/access/organizational-units',
        headers,
        payload: { type: 'team', name, parentId },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    };

    it("lets a member without a role read the units: id, name and tree only, never another tenant's", async () => {
      const x = tag();
      const top = await unit(t.admin.headers, `Sales ${x}`);
      const north = await unit(t.admin.headers, `North ${x}`, top);
      const east = await unit(t.admin.headers, `East ${x}`, north);
      const other = await tenantWithAdmin(app);
      const theirs = await unit(other.admin.headers, `Sales ${x} elsewhere`);
      const plain = await named(`Plain ${x}`);
      expect(
        (await get('/v1/access/organizational-units', plain.headers))
          .statusCode,
      ).toBe(403);

      const res = await get(`/v1/organizational-units?q=${x}`, plain.headers);
      expect(res.json()).toEqual({
        items: [
          {
            id: east,
            type: 'team',
            name: `East ${x}`,
            parentId: north,
            depth: 2,
          },
          {
            id: north,
            type: 'team',
            name: `North ${x}`,
            parentId: top,
            depth: 1,
          },
          {
            id: top,
            type: 'team',
            name: `Sales ${x}`,
            parentId: null,
            depth: 0,
          },
        ],
        nextCursor: null,
      });

      // By id: ours; another tenant's or an unknown id is absent.
      const byId = await get(
        `/v1/organizational-units?id=${top},${theirs},${randomUUID()}`,
        plain.headers,
      );
      expect((byId.json().items as UnitRef[]).map((row) => row.id)).toEqual([
        top,
      ]);

      // Cursor pages: newest first.
      const q = `q=${x}&limit=2`;
      const first = (
        await get(`/v1/organizational-units?${q}`, plain.headers)
      ).json();
      expect((first.items as UnitRef[]).map((row) => row.id)).toEqual([
        east,
        north,
      ]);
      expect(first.nextCursor).toBe(north);
      const second = (
        await get(
          `/v1/organizational-units?${q}&cursor=${first.nextCursor}`,
          plain.headers,
        )
      ).json();
      expect((second.items as UnitRef[]).map((row) => row.id)).toEqual([top]);
      expect(second.nextCursor).toBeNull();

      // Theirs reads only theirs.
      const back = await get(
        `/v1/organizational-units?q=${x}`,
        other.admin.headers,
      );
      expect((back.json().items as UnitRef[]).map((row) => row.id)).toEqual([
        theirs,
      ]);
    });

    it('searches names with % and _ as themselves', async () => {
      const x = tag();
      const literal = await unit(t.admin.headers, `Ops_100% ${x}`);
      await unit(t.admin.headers, `Opsx100x ${x}`);
      const plain = await named(`Plain ${x}`);
      const res = await get(
        `/v1/organizational-units?q=${encodeURIComponent(`ps_100% ${x}`)}`,
        plain.headers,
      );
      expect((res.json().items as UnitRef[]).map((row) => row.id)).toEqual([
        literal,
      ]);
    });

    it('validates the query (400) and is for users only', async () => {
      const plain = await named(`Plain ${tag()}`);
      for (const query of [
        'q=',
        `q=${'x'.repeat(101)}`,
        'id=nope',
        'limit=101',
        'cursor=nope',
        'x=1',
      ]) {
        const res = await get(
          `/v1/organizational-units?${query}`,
          plain.headers,
        );
        expect(res.statusCode).toBe(400);
      }
      const client = await apiClient(app, t.tenantId);
      expect(
        (await get('/v1/organizational-units', client.headers)).statusCode,
      ).toBe(401);
      expect((await get('/v1/organizational-units')).statusCode).toBe(401);
    });
  });
});
