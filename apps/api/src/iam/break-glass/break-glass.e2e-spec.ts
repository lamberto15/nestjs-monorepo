import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable, Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { signIn } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { SharedOutboxModule } from '../../core/outbox/outbox.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { roles } from '../access/access.tables.js';
import { RolesService } from '../access/roles.service.js';
import { auditLog } from '../audit/audit.tables.js';
import { AuditLogModule } from '../audit-log/audit-log.module.js';
import { AuthPolicySource } from '../auth/auth-policy.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { HoldsModule } from '../holds/holds.module.js';
import { InvitationsModule } from '../invitations/invitations.module.js';
import { BreakGlassModule } from './break-glass.module.js';
import { breakGlassGrants } from './break-glass.tables.js';

/** The tenants' sign-in policy, as iam/auth-policy would answer it: the ones that opted out. */
@AuthPolicySource()
@Injectable()
class TestPolicy implements AuthPolicySource {
  static readonly optedOut = new Set<string>();
  async allowsBreakGlass(tenantId: string) {
    return !TestPolicy.optedOut.has(tenantId);
  }
}

@Module({ providers: [TestPolicy] })
class TestPolicyModule {}

/** The error a database refused with: Drizzle wraps it in `cause`. */
const codeOf = (error: unknown) =>
  (error as { cause?: { code?: string }; code?: string }).cause?.code ??
  (error as { code?: string }).code;

const OPS = vi.hoisted(() => {
  const slug = `ops-bg-${process.pid}-${Date.now()}`;
  Object.assign(process.env, {
    SCHEDULER: 'off',
    REDIS_PREFIX: `test-break-glass-${process.pid}-${Date.now()}`,
    OPERATOR_TENANT: slug,
  });
  return slug;
});

type Headers = Record<string, string>;

describe('break-glass (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let operator: Headers;
  let operatorTenantId: string;
  let target: Awaited<ReturnType<typeof tenantWithAdmin>>;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      SharedOutboxModule,
      AuditLogModule,
      TestPolicyModule,
      BreakGlassModule,
      QueuesModule,
      HoldsModule,
      InvitationsModule,
    );
    db = app.get<Database>(getDrizzleToken());
    // The boot makes the operators' tenant (OPERATOR_TENANT), roles seeded.
    let [ops] = await db.select().from(tenants).where(eq(tenants.slug, OPS));
    if (!ops) {
      ops = await app.get(Tenancy).create({ slug: OPS, name: 'Operators' });
      await app
        .get(Tenancy)
        .run(ops.id, () =>
          app
            .get(TransactionHost)
            .withTransaction(() => app.get(RolesService).seedTenantRoles()),
        );
    }
    operatorTenantId = ops.id;
    const { email } = await member(app, ops.id, ['administrator']);
    operator = (await signIn(app, email)).headers;
    target = await tenantWithAdmin(app);
  });
  afterAll(() => app.close());

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const grants = (tenantId: string) => `/v1/tenants/${tenantId}/break-glass`;
  const reason = { reason: 'Incident 42: their exports fail' };
  const entries = (tenantId: string, action: string) =>
    app.get(Tenancy).run(tenantId, () =>
      db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, action), eq(auditLog.tenantId, tenantId)),
        ),
    );

  it('opens a grant once, audited in both tenants, and ends it', async () => {
    const opened = await call(
      'POST',
      grants(target.tenantId),
      operator,
      reason,
    );
    expect(opened.statusCode).toBe(201);
    const grant = opened.json();
    expect(grant).toMatchObject({
      tenantId: target.tenantId,
      reason: reason.reason,
      endedAt: null,
    });

    const again = await call('POST', grants(target.tenantId), operator, reason);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('break_glass_active');

    expect(
      await entries(target.tenantId, 'tenant.break-glass-started'),
    ).toHaveLength(1);
    expect(
      await entries(operatorTenantId, 'tenant.break-glass-started'),
    ).not.toHaveLength(0);
    const signIns = await entries(target.tenantId, 'member.signed-in');
    expect(
      signIns.some(
        (entry) =>
          (entry.details as { method?: string } | null)?.method ===
          'break-glass',
      ),
    ).toBe(true);

    const listed = await call('GET', grants(target.tenantId), operator);
    expect(
      listed.json<{ items: { id: string }[] }>().items.map((g) => g.id),
    ).toContain(grant.id);

    const ended = await call(
      'DELETE',
      `${grants(target.tenantId)}/${grant.id}`,
      operator,
    );
    expect(ended.statusCode).toBe(200);
    expect(ended.json().endedAt).not.toBeNull();
    expect(
      await entries(target.tenantId, 'tenant.break-glass-ended'),
    ).toHaveLength(1);
  });

  /** A request through grant `id`. */
  const through = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    id: string,
    payload?: object,
  ) => call(method as 'GET', url, { ...operator, 'break-glass': id }, payload);
  const open = async (tenantId = target.tenantId) => {
    const response = await call('POST', grants(tenantId), operator, reason);
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; expiresAt: string };
  };
  const end = (grantId: string, tenantId = target.tenantId) =>
    call('DELETE', `${grants(tenantId)}/${grantId}`, operator);

  it('reads the tenant through a grant, read only, each read audited there', async () => {
    const grant = await open();

    // Who am I: the grant's tenant, and the principal says it is break-glass.
    const me = await through('GET', '/v1/auth/me', grant.id);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: {
        tenantId: target.tenantId,
        breakGlass: {
          grantId: grant.id,
          tenantId: target.tenantId,
          operatorTenantId,
          expiresAt: grant.expiresAt,
        },
      },
      tenant: { id: target.tenantId, operator: false },
    });

    // The tenant's data on several routes, though the operator holds no role there.
    const users = await through('GET', '/v1/access/users', grant.id);
    expect(users.statusCode).toBe(200);
    expect(JSON.stringify(users.json())).toContain(target.admin.email);
    const log = await through('GET', '/v1/access/audit', grant.id);
    expect(log.statusCode).toBe(200);
    expect(JSON.stringify(log.json())).toContain(grant.id);
    const roleList = await through('GET', '/v1/access/roles', grant.id);
    expect(roleList.statusCode).toBe(200);
    // Routes guarded by a manage action read too (nothing is written).
    for (const url of [
      `/v1/access/users/${target.admin.id}/explanation?subject=Access`,
      '/v1/access/invitations',
      '/v1/legal-holds',
    ]) {
      const read = await through('GET', url, grant.id);
      expect(read.statusCode, url).toBe(200);
    }

    // The same routes without the header show the operators' own tenant.
    const own = await call('GET', '/v1/access/users', operator);
    expect(JSON.stringify(own.json())).not.toContain(target.admin.email);

    // Each read is in the tenant's own log, labelled as break-glass.
    const reads = await entries(target.tenantId, 'tenant.break-glass-read');
    expect(reads.length).toBeGreaterThanOrEqual(4);
    expect(reads[0]).toMatchObject({
      actorLabel: expect.stringContaining('(break-glass)'),
      details: expect.objectContaining({ grantId: grant.id, method: 'GET' }),
    });
    await end(grant.id);
  });

  it('refuses every write, in access and in the database', async () => {
    const grant = await open();
    const before = await app
      .get(Tenancy)
      .run(target.tenantId, () => db.select({ id: roles.id }).from(roles));

    for (const [method, url, payload] of [
      ['POST', '/v1/access/roles', { name: 'Smuggled', permissions: [] }],
      ['PATCH', `/v1/access/users/${target.admin.id}`, { roles: [] }],
      ['DELETE', `/v1/access/roles/${before[0]!.id}`, undefined],
    ] as const) {
      const write = await through(method, url, grant.id, payload);
      expect(write.statusCode).toBe(403);
      expect(write.json().code).toBe('break_glass_read_only');
    }
    const after = await app
      .get(Tenancy)
      .run(target.tenantId, () => db.select({ id: roles.id }).from(roles));
    expect(after).toEqual(before);

    // Below access: a service's write in the request's scope fails in PostgreSQL.
    const cls = app.get(ClsService);
    const refused = await cls.run(async () => {
      app.get(Tenancy).enter(target.tenantId, { readOnly: true });
      return app
        .get(TransactionHost)
        .withTransaction(() => app.get(RolesService).seedTenantRoles())
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    });
    expect(codeOf(refused)).toBe('25006');
    expect(
      await app
        .get(Tenancy)
        .run(target.tenantId, () => db.select({ id: roles.id }).from(roles)),
    ).toEqual(before);
    await end(grant.id);
  });

  it('refuses a grant that is unknown, someone else’s, ended or expired', async () => {
    const unknown = await through('GET', '/v1/auth/me', randomUUID());
    expect(unknown.statusCode).toBe(403);
    expect(unknown.json().code).toBe('break_glass_invalid');

    const grant = await open();
    // Another tenant's administrator holds no grant, whatever the header.
    const outsider = await call('GET', '/v1/auth/me', {
      ...(await signIn(app, target.admin.email)).headers,
      'break-glass': grant.id,
    });
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json().code).toBe('break_glass_invalid');
    // Without credentials, a public route refuses the header too.
    const guest = await call('GET', '/v1/auth/methods', {
      'break-glass': grant.id,
    });
    expect(guest.statusCode).toBe(403);
    expect(guest.json().code).toBe('break_glass_invalid');

    expect((await end(grant.id)).statusCode).toBe(200);
    const ended = await through('GET', '/v1/access/users', grant.id);
    expect(ended.statusCode).toBe(403);
    expect(ended.json().code).toBe('break_glass_invalid');

    const late = await open();
    await app.get(Tenancy).run(operatorTenantId, () =>
      db
        .update(breakGlassGrants)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(breakGlassGrants.id, late.id)),
    );
    const expired = await through('GET', '/v1/access/users', late.id);
    expect(expired.statusCode).toBe(403);
    expect(expired.json().code).toBe('break_glass_expired');

    // Without the header, the operator is back in their own tenant.
    const me = await call('GET', '/v1/auth/me', operator);
    expect(me.json().user).toMatchObject({ tenantId: operatorTenantId });
    expect(me.json().user.breakGlass).toBeUndefined();
  });

  it('refuses a tenant whose sign-in policy forbids break-glass', async () => {
    const other = await tenantWithAdmin(app);
    const running = await open(other.tenantId);
    TestPolicy.optedOut.add(other.tenantId);
    try {
      const refused = await call(
        'POST',
        grants(other.tenantId),
        operator,
        reason,
      );
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe('break_glass_disabled');
      // A grant opened before stops at its next request.
      const stopped = await through('GET', '/v1/access/users', running.id);
      expect(stopped.statusCode).toBe(403);
      expect(stopped.json().code).toBe('break_glass_disabled');
    } finally {
      TestPolicy.optedOut.delete(other.tenantId);
    }
    await end(running.id, other.tenantId);
  });

  it('refuses the operators’ own tenant and anyone but an operator', async () => {
    const own = await call('POST', grants(operatorTenantId), operator, reason);
    expect(own.statusCode).toBe(409);
    expect(own.json().code).toBe('break_glass_own_tenant');

    const short = await call('POST', grants(target.tenantId), operator, {
      reason: 'why',
    });
    expect(short.statusCode).toBe(400);

    const admin = (await signIn(app, target.admin.email)).headers;
    const other = await tenantWithAdmin(app);
    const refused = await call('POST', grants(other.tenantId), admin, reason);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('operator_required');
  });
});
