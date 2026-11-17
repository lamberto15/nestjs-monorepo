import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { signIn } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { RolesService } from '../access/roles.service.js';
import { auditLog } from '../audit/audit.tables.js';
import { BreakGlassModule } from './break-glass.module.js';

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
    app = await bootModules(...accessModules(), BreakGlassModule);
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
    expect(listed.json().map((g: { id: string }) => g.id)).toContain(grant.id);

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

  it('fails closed on a request through a grant', async () => {
    const grant = (
      await call('POST', grants(target.tenantId), operator, reason)
    ).json();
    const through = (method: 'GET' | 'POST', id: string) =>
      call(method, grants(target.tenantId), { ...operator, 'break-glass': id });

    const read = await through('GET', grant.id);
    expect(read.statusCode).toBe(403);
    expect(read.json().code).toBe('break_glass_unavailable');

    const write = await through('POST', grant.id);
    expect(write.statusCode).toBe(403);
    expect(write.json().code).toBe('break_glass_read_only');

    const unknown = await through('GET', randomUUID());
    expect(unknown.statusCode).toBe(403);
    expect(unknown.json().code).toBe('break_glass_invalid');

    // Another tenant's administrator holds no grant, whatever the header.
    const outsider = await call('GET', grants(target.tenantId), {
      ...(await signIn(app, target.admin.email)).headers,
      'break-glass': grant.id,
    });
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json().code).toBe('break_glass_invalid');
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
