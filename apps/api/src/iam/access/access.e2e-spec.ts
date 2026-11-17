import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  roleIds,
  seededAdmin,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../audit/audit.tables.js';
import { memberships, users } from '../auth/auth.tables.js';
import { AccessService } from './access.service.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-access-${process.pid}-${Date.now()}`;
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  process.env.ADMIN_ONBOARDING = 'off';
});

type Headers = Record<string, string>;

describe('access control (e2e)', () => {
  let app: NestNodeApplication;
  let admin: Awaited<ReturnType<typeof seededAdmin>>;
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers = {},
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  beforeAll(async () => {
    app = await bootModules(...accessModules());
    admin = await seededAdmin(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  const db = () => app.get<Database>(getDrizzleToken());
  const auditActions = async (tenantId: string) =>
    (
      await app
        .get(Tenancy)
        .run(tenantId, () =>
          db().select({ action: auditLog.action }).from(auditLog),
        )
    ).map((row) => row.action);

  it('seeds on the first start: the tenant, Administrator and the seed roles, the administrator', async () => {
    const roles = await call('GET', '/v1/access/roles', admin.headers);
    expect(roles.statusCode).toBe(200);
    expect(
      roles.json().items.map((role: { name: string }) => role.name),
    ).toEqual(['Administrator', 'Editor', 'Unit lead', 'Viewer']);
    expect(await auditActions(admin.tenantId)).toContain('user.seeded');
  });

  it('shows the catalog with its texts, and the system jobs', async () => {
    const catalog = (
      await call('GET', '/v1/access/catalog', admin.headers)
    ).json();
    const access = catalog.subjects.find(
      (s: { subject: string }) => s.subject === 'Access',
    );
    expect(access).toMatchObject({ label: 'Access control' });
    expect(access.actions.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining([
        'manageRoles',
        'manageUsers',
        'manageOrganizationalUnits',
      ]),
    );
    expect(catalog.systemJobs).toContainEqual(
      expect.objectContaining({
        key: 'seed',
        actor: 'system:seed',
        label: 'First-boot seed',
      }),
    );
  });

  it('opens each route only to the permissions it needs: 403 otherwise', async () => {
    const viewer = await member(app, admin.tenantId, ['viewer']);
    expect(
      (await call('GET', '/v1/access/roles', viewer.headers)).statusCode,
    ).toBe(403);
    expect(
      (await call('GET', '/v1/access/catalog', viewer.headers)).statusCode,
    ).toBe(403);
    expect((await call('GET', '/v1/access/roles')).statusCode).toBe(401);
  });

  it('applies a role change from the next request', async () => {
    const user = await member(app, admin.tenantId, []);
    expect(
      (await call('GET', '/v1/access/roles', user.headers)).statusCode,
    ).toBe(403);
    const created = await call('POST', '/v1/access/roles', admin.headers, {
      name: `managers-${randomUUID().slice(0, 8)}`,
      permissions: [
        { subject: 'Access', action: 'manageRoles', conditions: [] },
      ],
    });
    expect(created.statusCode).toBe(201);
    const patched = await call(
      'PATCH',
      `/v1/access/users/${user.id}`,
      admin.headers,
      {
        roleIds: [created.json().id],
      },
    );
    expect(patched.statusCode).toBe(204);
    expect(
      (await call('GET', '/v1/access/roles', user.headers)).statusCode,
    ).toBe(200);
  });

  it('refuses a role save or delete from a stale read: 412 with If-Match', async () => {
    const role = {
      name: `auditor-${randomUUID().slice(0, 8)}`,
      permissions: [
        { subject: 'Access', action: 'manageUsers', conditions: [] },
      ],
    };
    const created = await call('POST', '/v1/access/roles', admin.headers, role);
    const url = `/v1/access/roles/${created.json().id}`;
    const etag = (await call('GET', url, admin.headers)).headers.etag as string;
    expect(etag).toMatch(/^"/);
    // A grant changes `members`, not the role: the tag stays.
    await member(app, admin.tenantId, [created.json().id]);
    expect((await call('GET', url, admin.headers)).headers.etag).toBe(etag);

    const saved = await call(
      'PATCH',
      url,
      { ...admin.headers, 'if-match': etag },
      { ...role, description: 'first' },
    );
    expect(saved.statusCode).toBe(204);
    const stale = await call(
      'PATCH',
      url,
      { ...admin.headers, 'if-match': etag },
      { ...role, description: 'second' },
    );
    expect(stale.statusCode).toBe(412);
    const current = (await call('GET', url, admin.headers)).headers.etag;
    expect(saved.headers.etag).toBe(current);
    expect(stale.json()).toMatchObject({
      code: 'precondition_failed',
      etag: current,
    });
    expect((await call('GET', url, admin.headers)).json().description).toBe(
      'first',
    );
    expect(
      (await call('DELETE', url, { ...admin.headers, 'if-match': etag }))
        .statusCode,
    ).toBe(412);
    expect(
      (
        await call('DELETE', url, {
          ...admin.headers,
          'if-match': current as string,
        })
      ).statusCode,
    ).toBe(204);
  });

  describe('safeguards', () => {
    /** A member who may manage roles and users, and nothing else. */
    async function accessManager(
      tenantId = admin.tenantId,
      headers = admin.headers,
    ) {
      const role = await call('POST', '/v1/access/roles', headers, {
        name: `access-manager-${randomUUID().slice(0, 8)}`,
        permissions: [
          { subject: 'Access', action: 'manageRoles', conditions: [] },
          { subject: 'Access', action: 'manageUsers', conditions: [] },
        ],
      });
      return member(app, tenantId, [role.json().id]);
    }

    it("refuses to grant what the granter doesn't hold without conditions", async () => {
      const manager = await accessManager();
      const refused = await call('POST', '/v1/access/roles', manager.headers, {
        name: 'Units',
        permissions: [
          {
            subject: 'Access',
            action: 'manageOrganizationalUnits',
            conditions: [],
          },
        ],
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().detail).toContain(
        'You can’t grant Access.manageOrganizationalUnits',
      );
      // Nor give someone the Administrator role, nor act on an administrator.
      const user = await member(app, admin.tenantId, []);
      const [administrator] = await roleIds(
        app,
        admin.tenantId,
        'administrator',
      );
      expect(
        (
          await call('PATCH', `/v1/access/users/${user.id}`, manager.headers, {
            roleIds: [administrator],
          })
        ).statusCode,
      ).toBe(403);
      const other = await member(app, admin.tenantId, ['administrator']);
      const authority = await call(
        'PATCH',
        `/v1/access/users/${other.id}`,
        manager.headers,
        { active: false },
      );
      expect(authority.statusCode).toBe(403);
      expect(authority.json().code).toBe('authority_required');
    });

    it('refuses permissions and conditions the catalog does not declare: 400', async () => {
      for (const permission of [
        {
          subject: 'Access',
          action: 'manageRoles',
          conditions: [{ key: 'undeclared' }],
        },
        { subject: 'Nope', action: 'read', conditions: [] },
      ]) {
        const refused = await call('POST', '/v1/access/roles', admin.headers, {
          name: `bad-${randomUUID().slice(0, 8)}`,
          permissions: [permission],
        });
        expect(refused.statusCode).toBe(400);
      }
    });

    it('keeps the built-in Administrator role, and at least one active administrator', async () => {
      const { tenantId, admin: only } = await tenantWithAdmin(app);
      const [administrator] = await roleIds(app, tenantId, 'administrator');
      expect(
        (
          await call(
            'DELETE',
            `/v1/access/roles/${administrator}`,
            only.headers,
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await call(
            'PATCH',
            `/v1/access/roles/${administrator}`,
            only.headers,
            { name: 'x', permissions: [] },
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await call('PATCH', `/v1/access/users/${only.id}`, only.headers, {
            roleIds: [],
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await call('PATCH', `/v1/access/users/${only.id}`, only.headers, {
            active: false,
          })
        ).statusCode,
      ).toBe(409);
      // A second administrator: now the first may step down.
      const second = await member(app, tenantId, ['administrator']);
      expect(
        (
          await call('PATCH', `/v1/access/users/${only.id}`, second.headers, {
            roleIds: [],
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await call('PATCH', `/v1/access/users/${second.id}`, second.headers, {
            roleIds: [],
          })
        ).statusCode,
      ).toBe(409);
    });

    it('ends a grant at its expiry, and refuses an end in the past', async () => {
      const user = await member(app, admin.tenantId, []);
      const [editor] = await roleIds(app, admin.tenantId, 'editor');
      const past = await call(
        'PATCH',
        `/v1/access/users/${user.id}`,
        admin.headers,
        {
          roleIds: [editor],
          roleExpiresAt: {
            [editor!]: new Date(Date.now() - 1000).toISOString(),
          },
        },
      );
      expect(past.statusCode).toBe(400);
      const stray = await call(
        'PATCH',
        `/v1/access/users/${user.id}`,
        admin.headers,
        {
          roleIds: [],
          roleExpiresAt: {
            [editor!]: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      );
      expect(stray.statusCode).toBe(400);
      const until = new Date(Date.now() + 60_000).toISOString();
      expect(
        (
          await call('PATCH', `/v1/access/users/${user.id}`, admin.headers, {
            roleIds: [editor],
            roleExpiresAt: { [editor!]: until },
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (await call('GET', `/v1/access/users/${user.id}`, admin.headers)).json()
          .roles,
      ).toEqual([{ roleId: editor, expiresAt: until }]);
    });

    it("deactivates a membership, never one's own, and refuses an account field", async () => {
      const user = await member(app, admin.tenantId, []);
      expect(
        (
          await call('PATCH', `/v1/access/users/${admin.id}`, admin.headers, {
            active: false,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await call('PATCH', `/v1/access/users/${user.id}`, admin.headers, {
            name: 'x',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call('PATCH', `/v1/access/users/${user.id}`, admin.headers, {
            active: false,
          })
        ).statusCode,
      ).toBe(204);
      const [row] = await db()
        .select({ active: memberships.active })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, user.id),
            eq(memberships.tenantId, admin.tenantId),
          ),
        );
      expect(row?.active).toBe(false);
      expect(
        (await call('GET', '/v1/access/catalog', user.headers)).statusCode,
      ).toBe(401);
    });

    it('audits every access change in its transaction', async () => {
      await accessManager();
      expect(await auditActions(admin.tenantId)).toEqual(
        expect.arrayContaining(['role.created', 'user.updated', 'user.seeded']),
      );
    });
  });

  it("lists the tenant's members, filtered, and only theirs", async () => {
    const ada = await member(app, admin.tenantId, ['viewer'], {
      email: `ada-${randomUUID()}@acme.dev`,
    });
    const found = await call(
      'GET',
      '/v1/access/users?email.startsWith=ada-',
      admin.headers,
    );
    expect(found.statusCode).toBe(200);
    expect(found.json().items.map((u: { id: string }) => u.id)).toContain(
      ada.id,
    );
    expect(found.json().items[0]).toMatchObject({
      kind: 'user',
      unitIds: [],
      hasPassword: true,
    });
    expect(
      (await call('GET', '/v1/access/users?active=maybe', admin.headers))
        .statusCode,
    ).toBe(400);
    const other = await tenantWithAdmin(app);
    expect(
      (await call('GET', `/v1/access/users/${ada.id}`, other.admin.headers))
        .statusCode,
    ).toBe(404);
    const theirs = (
      await call('GET', '/v1/access/users', other.admin.headers)
    ).json().items;
    expect(theirs.map((u: { id: string }) => u.id)).toEqual([other.admin.id]);
  });

  it('searches the principals: members and API clients, as keys', async () => {
    const grace = await member(app, admin.tenantId, [], {
      name: 'Grace Hopper',
    });
    const page = await call(
      'GET',
      '/v1/access/principals?q=grace%20hop',
      admin.headers,
    );
    expect(page.statusCode).toBe(200);
    expect(page.json().items).toEqual([
      {
        id: grace.id,
        key: `user:${grace.id}`,
        kind: 'user',
        label: 'Grace Hopper',
        email: grace.email,
        active: true,
      },
    ]);
  });

  describe('explaining access', () => {
    it('explains each action as the engine decides it, and an ended grant counts for nothing', async () => {
      const managers = await call('POST', '/v1/access/roles', admin.headers, {
        name: `explain-${randomUUID().slice(0, 8)}`,
        permissions: [
          { subject: 'Access', action: 'manageUsers', conditions: [] },
        ],
      });
      const roleId = managers.json().id as string;
      const user = await member(app, admin.tenantId, [roleId]);
      const explained = await call(
        'GET',
        `/v1/access/users/${user.id}/explanation?subject=Access`,
        admin.headers,
      );
      expect(explained.statusCode).toBe(200);
      const body = explained.json();
      expect(body.user).toMatchObject({ id: user.id, email: user.email });
      const action = (name: string) =>
        body.actions.find((a: { action: string }) => a.action === name);
      expect(action('manageUsers')).toMatchObject({
        allowed: true,
        grants: [{ roleId, matches: true }],
      });
      expect(action('manageRoles')).toMatchObject({
        allowed: false,
        grants: [],
      });
      expect(body.roles).toEqual([
        expect.objectContaining({ id: roleId, expired: false }),
      ]);

      expect(
        (
          await call(
            'GET',
            `/v1/access/users/${user.id}/explanation?subject=Nothing`,
            admin.headers,
          )
        ).json().code,
      ).toBe('unknown_subject');
      expect(
        (
          await call(
            'GET',
            `/v1/access/users/${user.id}/explanation?subject=Access&recordId=${randomUUID()}`,
            admin.headers,
          )
        ).json().code,
      ).toBe('subject_without_records');
      const viewer = await member(app, admin.tenantId, ['viewer']);
      expect(
        (
          await call(
            'GET',
            `/v1/access/users/${user.id}/explanation?subject=Access`,
            viewer.headers,
          )
        ).statusCode,
      ).toBe(403);
      const other = await tenantWithAdmin(app);
      expect(
        (
          await call(
            'GET',
            `/v1/access/users/${user.id}/explanation?subject=Access`,
            other.admin.headers,
          )
        ).statusCode,
      ).toBe(404);
    });
  });

  it('gives the system principal only its job’s permissions, and a principal from data nothing', async () => {
    const access = app.get(AccessService);
    await app.get(Tenancy).run(admin.tenantId, async () => {
      expect(
        await access.permissions({ kind: 'system', id: 'seed' } as never),
      ).toEqual([]);
      expect(
        await access.can(
          { kind: 'system', id: 'seed' } as never,
          'manageRoles',
          'Access',
        ),
      ).toBe(false);
    });
    const [seeded] = await db()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'admin@example.com'));
    expect(seeded?.id).toBe(admin.id);
  });
});
