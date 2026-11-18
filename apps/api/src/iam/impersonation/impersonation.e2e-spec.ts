import { randomUUID } from 'node:crypto';
import { Controller, Get, Module, VERSION_NEUTRAL } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  roleIds,
  tenantWithAdmin,
} from '../../../test/access.js';
import { cookieOf, signIn } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../audit/audit.tables.js';
import type { UserPrincipal } from '../auth/principal.js';
import { ImpersonationModule } from './impersonation.module.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    REDIS_PREFIX: `test-impersonation-${process.pid}-${Date.now()}`,
    IMPERSONATION: 'on',
  });
});

@Controller({ path: 'probe', version: VERSION_NEUTRAL })
class ProbeController {
  @Get('me')
  @Can.Anyone()
  me(@CurrentUser() user: UserPrincipal) {
    return user;
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

type Headers = Record<string, string>;

describe('impersonation (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Headers;
  /** The administrator's access token: it outlives their session's replacement. */
  let adminToken: Headers;
  let adminId: string;
  let editor: { id: string; email: string };

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      ImpersonationModule,
      ProbeModule,
    );
    const tenant = await tenantWithAdmin(app);
    tenantId = tenant.tenantId;
    adminId = tenant.admin.id;
    admin = (await signIn(app, tenant.admin.email)).headers;
    adminToken = tenant.admin.headers;
    editor = await member(app, tenantId, ['editor']);
  });
  afterAll(() => app.close());

  const post = (url: string, headers: Headers) =>
    app.inject({ method: 'POST', url, headers });
  const me = async (headers: Headers) =>
    (await app.inject({ method: 'GET', url: '/probe/me', headers })).json();
  const entries = (action: string) =>
    app.get(Tenancy).run(tenantId, () =>
      app
        .get<Database>(getDrizzleToken())
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, action), eq(auditLog.targetId, editor.id)),
        ),
    );

  it('acts as a member and back, audited both ways', async () => {
    const started = await post(
      `/v1/access/users/${editor.id}/impersonate`,
      admin,
    );
    expect(started.statusCode).toBe(204);
    const as = { cookie: cookieOf(started.headers['set-cookie']) };
    expect(await me(as)).toMatchObject({
      id: editor.id,
      impersonator: { id: adminId },
    });
    // The administrator's session was replaced.
    expect(
      (await app.inject({ method: 'GET', url: '/probe/me', headers: admin }))
        .statusCode,
    ).toBe(401);

    // Never nested, and an impersonation is no recent sign-in.
    const nested = await post(`/v1/access/users/${adminId}/impersonate`, as);
    expect(nested.statusCode).toBe(403);

    const stopped = await post('/v1/auth/impersonation/stop', as);
    expect(stopped.statusCode).toBe(204);
    const back = { cookie: cookieOf(stopped.headers['set-cookie']) };
    const self = await me(back);
    expect(self.id).toBe(adminId);
    expect(self.impersonator).toBeUndefined();
    expect(self.tenantId).toBe(tenantId);

    expect(await entries('user.impersonation-started')).toHaveLength(1);
    expect(await entries('user.impersonation-stopped')).toHaveLength(1);
    admin = back;
  });

  it('refuses oneself, an administrator, a stranger and a non-administrator', async () => {
    const yourself = await post(
      `/v1/access/users/${adminId}/impersonate`,
      admin,
    );
    expect(yourself.statusCode).toBe(409);
    expect(yourself.json().code).toBe('impersonating_yourself');

    const other = await member(app, tenantId, ['administrator']);
    const administrator = await post(
      `/v1/access/users/${other.id}/impersonate`,
      admin,
    );
    expect(administrator.statusCode).toBe(403);
    expect(administrator.json().code).toBe('administrator_not_impersonated');

    const elsewhere = await tenantWithAdmin(app);
    const stranger = await member(app, elsewhere.tenantId, ['editor']);
    expect(
      (await post(`/v1/access/users/${stranger.id}/impersonate`, admin))
        .statusCode,
    ).toBe(404);

    const asEditor = (await signIn(app, editor.email)).headers;
    expect(
      (await post(`/v1/access/users/${adminId}/impersonate`, asEditor))
        .statusCode,
    ).toBe(403);
    expect(
      (await post('/v1/auth/impersonation/stop', asEditor)).statusCode,
    ).toBe(409);
  });
  describe('once the rule of its start no longer holds', () => {
    /** A member who may impersonate, and nothing else, acting as a member with no roles. */
    async function impersonating() {
      const role = await app.inject({
        method: 'POST',
        url: '/v1/access/roles',
        headers: adminToken,
        payload: {
          name: `support-${randomUUID().slice(0, 8)}`,
          permissions: [
            { subject: 'Access', action: 'impersonate', conditions: [] },
          ],
        },
      });
      expect(role.statusCode).toBe(201);
      const support = await member(app, tenantId, [role.json().id]);
      const target = await member(app, tenantId, []);
      const started = await post(
        `/v1/access/users/${target.id}/impersonate`,
        (await signIn(app, support.email)).headers,
      );
      expect(started.statusCode).toBe(204);
      const as = { cookie: cookieOf(started.headers['set-cookie']) };
      expect(await me(as)).toMatchObject({
        id: target.id,
        impersonator: { id: support.id },
      });
      return { support, target, as };
    }
    const setRoles = (userId: string, roleIds: string[]) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/access/users/${userId}`,
        headers: adminToken,
        payload: { roleIds },
      });
    const probe = (headers: Headers) =>
      app.inject({ method: 'GET', url: '/probe/me', headers });

    it('ends when the target is given what the actor does not hold', async () => {
      const { target, as } = await impersonating();
      const stronger = await app.inject({
        method: 'POST',
        url: '/v1/access/roles',
        headers: adminToken,
        payload: {
          name: `users-${randomUUID().slice(0, 8)}`,
          permissions: [
            { subject: 'Access', action: 'manageUsers', conditions: [] },
          ],
        },
      });
      expect((await setRoles(target.id, [stronger.json().id])).statusCode).toBe(
        204,
      );
      expect((await probe(as)).statusCode).toBe(401);
    });

    it('ends when the target is made an administrator', async () => {
      const { target, as } = await impersonating();
      const [administrator] = await roleIds(app, tenantId, 'administrator');
      expect((await setRoles(target.id, [administrator!])).statusCode).toBe(
        204,
      );
      expect((await probe(as)).statusCode).toBe(401);
    });

    it('ends when the actor no longer may impersonate', async () => {
      const { support, as } = await impersonating();
      expect((await setRoles(support.id, [])).statusCode).toBe(204);
      expect((await probe(as)).statusCode).toBe(401);
    });
  });
});
