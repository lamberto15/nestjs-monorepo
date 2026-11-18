import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ConflictException, Injectable, Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { InMemoryMailTransport, MailTransport } from '@nestjs/mail';
import { OnEvent } from '@nestjs/event-emitter';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq, isNull } from 'drizzle-orm';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { cookieOf, createUser, signIn } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { SharedOutboxModule } from '../../core/outbox/outbox.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { roles } from '../access/access.tables.js';
import { RolesService } from '../access/roles.service.js';
import { type AuthConfig, authConfig } from '../auth/auth.config.js';
import { memberships, users } from '../auth/auth.tables.js';
import { UsersRepository } from '../auth/users.repository.js';
import { auditLog } from '../audit/audit.tables.js';
import { DomainChangeGuard } from './domain-change-guard.js';
import { SignUpSweepJob } from './sign-up-sweep.job.js';
import { TenantDeletionJob } from './tenant-deletion.job.js';
import { TenantDomainsService } from './tenant-domains.service.js';
import { invitations } from '../invitations/invitations.tables.js';
import {
  TENANT_EVENTS,
  type TenantDeactivatedEvent,
} from './tenants.events.js';
import { TenantsModule } from './tenants.module.js';
import { TenantsService } from './tenants.service.js';
import { tenantLifecycle } from './tenants.tables.js';

const OPS = await vi.hoisted(async () => {
  const slug = `ops-${process.pid}-${Date.now()}`;
  Object.assign(process.env, {
    SCHEDULER: 'off',
    REDIS_PREFIX: `test-tenants-${process.pid}-${Date.now()}`,
    OPERATOR_TENANT: slug,
    AUTH_SIGN_UP: 'on',
    TENANT_SIGN_UP: 'on',
    CUSTOM_DOMAINS: 'on',
    MAIL_TRANSPORT: 'memory',
  });
  return slug;
});

/** Records the tenants deactivated (realtime's listener, in the app). */
@Injectable()
class Deactivations {
  readonly deactivated: string[] = [];

  @OnEvent(TENANT_EVENTS.deactivated)
  onDeactivated(event: TenantDeactivatedEvent) {
    this.deactivated.push(event.tenantId);
  }
}

@Module({ providers: [Deactivations] })
class DeactivationsModule {}

/** Stands in for branding's lock (modules/branding): refuses while `locked`. */
@DomainChangeGuard()
@Injectable()
class BrandingLock {
  locked = false;

  assertEditable() {
    if (this.locked) {
      throw new ConflictException({ code: 'branding_locked' });
    }
    return Promise.resolve();
  }
}

@Module({ providers: [BrandingLock] })
class BrandingLockModule {}

type Headers = Record<string, string>;

describe('tenants (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let operator: Headers;
  let operatorTenantId: string;
  let operatorUserId: string;
  let other: { tenantId: string; admin: { headers: Headers } };

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      SharedOutboxModule,
      TenantsModule,
      DeactivationsModule,
      BrandingLockModule,
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
    const operatorMember = await member(app, ops.id, ['administrator']);
    operator = operatorMember.headers;
    operatorUserId = operatorMember.id;
    other = await tenantWithAdmin(app);
  });
  afterAll(() => app.close());

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  const create = (slug = `t-${randomUUID().slice(0, 8)}`) =>
    call('POST', '/v1/tenants', operator, {
      name: 'Acme',
      slug,
      administratorEmail: 'boss@acme.dev',
    });

  const entries = (
    action: string,
    targetId: string,
    tenantId: string | null = null,
  ) =>
    app.get(Tenancy).run(tenantId, () =>
      db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, action),
            eq(auditLog.targetId, targetId),
            tenantId
              ? eq(auditLog.tenantId, tenantId)
              : isNull(auditLog.tenantId),
          ),
        ),
    );

  it('answers only operators, whatever their roles elsewhere', async () => {
    const refused = await call('GET', '/v1/tenants', other.admin.headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('operator_required');

    const listed = await call('GET', '/v1/tenants?limit=100', operator);
    expect(listed.statusCode).toBe(200);
    const ops = listed
      .json()
      .items.find((tenant: { id: string }) => tenant.id === operatorTenantId);
    expect(ops).toMatchObject({ slug: OPS, operator: true, active: true });
  });

  it('creates a tenant with its first administrator invited, its slug once', async () => {
    const slug = `t-${randomUUID().slice(0, 8)}`;
    const created = await create(slug);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      slug,
      active: true,
      operator: false,
      administrator: { email: 'boss@acme.dev', status: 'invited' },
    });
    const taken = await create(slug);
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe('tenant_slug_taken');
  });

  it('invites the first administrator as Administrator, and mails the link', async () => {
    const created = (await create()).json();
    const [invitation, administrator] = await app
      .get(Tenancy)
      .run(created.id, () =>
        Promise.all([
          db
            .select()
            .from(invitations)
            .then((rows) => rows[0]),
          db
            .select({ id: roles.id })
            .from(roles)
            .where(eq(roles.key, 'administrator'))
            .then((rows) => rows[0]),
        ]),
      );
    expect(invitation).toMatchObject({
      email: 'boss@acme.dev',
      roleIds: [administrator!.id],
    });
    expect(new Date(created.administrator.expiresAt).getTime()).toBe(
      invitation!.expiresAt!.getTime(),
    );
    const mailbox = app.get(MailTransport) as InMemoryMailTransport;
    await vi.waitFor(
      () =>
        expect(
          mailbox.mails.some(
            (mail) =>
              mail.to.some((to) => to.address === 'boss@acme.dev') &&
              mail.html?.includes('/accept-invitation?token=inv_'),
          ),
        ).toBe(true),
      { timeout: 15_000 },
    );
  });

  it('ends a deactivated tenant’s sessions, never the operators’ tenant', async () => {
    const { tenantId, email } = await createUser(app, {
      tenantId: (await create()).json().id,
    });
    const { headers } = await signIn(app, email);
    expect((await call('GET', '/v1/auth/tenants', headers)).statusCode).toBe(
      200,
    );

    const off = await call('PATCH', `/v1/tenants/${tenantId}`, operator, {
      active: false,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().active).toBe(false);
    expect((await call('GET', '/v1/auth/tenants', headers)).statusCode).toBe(
      401,
    );
    expect(app.get(Deactivations).deactivated).toContain(tenantId);
    expect(
      await entries('tenant.updated', tenantId, operatorTenantId),
    ).toHaveLength(1);
    expect(await entries('tenant.updated', tenantId, tenantId)).toHaveLength(1);

    const ops = await call(
      'PATCH',
      `/v1/tenants/${operatorTenantId}`,
      operator,
      { active: false },
    );
    expect(ops.statusCode).toBe(409);
    expect(ops.json().code).toBe('operator_tenant');
  });

  it('keeps the operators’ slug to their tenant: never changed, never taken', async () => {
    const renamed = await call(
      'PATCH',
      `/v1/tenants/${operatorTenantId}`,
      operator,
      { slug: `${OPS}-moved` },
    );
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json().code).toBe('operator_tenant');
    const [ops] = await db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, operatorTenantId));
    expect(ops?.slug).toBe(OPS);
    // Its name still changes.
    expect(
      (
        await call('PATCH', `/v1/tenants/${operatorTenantId}`, operator, {
          name: 'Operators',
        })
      ).statusCode,
    ).toBe(200);

    // OPERATOR_TENANT naming a slug no tenant has yet: none may take it,
    // made or renamed, or its members would be the operators.
    const config = app.get<AuthConfig>(authConfig.KEY);
    const next = `${OPS}-next`;
    const tenant = (await create()).json();
    const service = app.get(TenantsService);
    const actor = (await app
      .get(UsersRepository)
      .inTenant(operatorUserId, operatorTenantId))!;
    config.operatorTenant = next;
    try {
      await expect(
        service.makeTenant({ name: 'Next', slug: next }, async () => null),
      ).rejects.toMatchObject({
        response: { code: 'tenant_slug_taken' },
      });
      await expect(
        app
          .get(Tenancy)
          .run(operatorTenantId, () =>
            service.update(actor, tenant.id, { slug: next }),
          ),
      ).rejects.toMatchObject({
        response: { code: 'tenant_slug_taken' },
      });
    } finally {
      config.operatorTenant = OPS;
    }
    expect(
      await db.select().from(tenants).where(eq(tenants.slug, next)),
    ).toHaveLength(0);
  });

  it('erases a tenant once its deletion’s grace period passed, unless cancelled', async () => {
    const tenant = (await create()).json();
    const url = `/v1/tenants/${tenant.id}/deletion`;

    const wrong = await call('POST', url, operator, { slug: 'not-it' });
    expect(wrong.statusCode).toBe(400);

    const requested = await call('POST', url, operator, { slug: tenant.slug });
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toMatchObject({ active: false });
    expect(requested.json().deletionScheduledFor).toBeTruthy();

    // Reactivating wants the deletion cancelled first.
    const back = await call('PATCH', `/v1/tenants/${tenant.id}`, operator, {
      active: true,
    });
    expect(back.statusCode).toBe(409);
    expect(back.json().code).toBe('tenant_deletion_pending');

    expect((await call('DELETE', url, operator)).statusCode).toBeLessThan(300);
    const job = app.get(TenantDeletionJob);
    const later = new Date(Date.now() + 400 * 86_400_000);
    await job.eraseDue(later);
    expect(await app.get(Tenancy).find(tenant.id)).toBeDefined();

    await call('POST', url, operator, { slug: tenant.slug });
    expect(await job.eraseDue(new Date())).toBe(0);
    expect(await job.eraseDue(later)).toBeGreaterThanOrEqual(1);
    expect(await app.get(Tenancy).find(tenant.id)).toBeUndefined();
    const [purged] = await entries('tenant.purged', tenant.id);
    expect(purged?.details).toMatchObject({
      slug: tenant.slug,
      reason: 'deletion',
    });
  });

  it('lets a sign-up make its own tenant, swept when nobody verifies', async () => {
    const email = `signup-${randomUUID()}@acme.dev`;
    const signedUp = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      payload: {
        email,
        name: 'Ada',
        password: 'a long enough password',
        tenantName: 'Ada & Co',
      },
    });
    expect(signedUp.statusCode).toBe(201);
    expect(signedUp.json()).toMatchObject({ email, emailVerified: false });

    const [row] = await db
      .select({ tenantId: memberships.tenantId, slug: tenants.slug })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(eq(users.email, email));
    expect(row?.slug).toMatch(/^ada-co-[a-z0-9]{6}$/);
    const [lifecycle] = await db
      .select()
      .from(tenantLifecycle)
      .where(eq(tenantLifecycle.tenantId, row!.tenantId));
    expect(lifecycle?.createdBySignUp).toBe(true);

    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      payload: { email, name: 'Ada', password: 'a long enough password' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('email_taken');

    const sweep = app.get(SignUpSweepJob);
    await sweep.sweep(new Date());
    expect(await app.get(Tenancy).find(row!.tenantId)).toBeDefined();
    await sweep.sweep(new Date(Date.now() + 8 * 86_400_000));
    expect(await app.get(Tenancy).find(row!.tenantId)).toBeUndefined();
    // The account stays, in no tenant.
    const [account] = await db
      .select()
      .from(users)
      .where(eq(users.email, email));
    expect(account).toBeDefined();
  });

  it('lists a user’s tenants and switches between them', async () => {
    const created = await createUser(app, { tenantId: other.tenantId });
    await db
      .insert(memberships)
      .values({ tenantId: operatorTenantId, userId: created.user.id });
    const { headers } = await signIn(app, created.email);

    const mine = await call('GET', '/v1/auth/tenants', headers);
    expect(mine.statusCode).toBe(200);
    const ids = mine.json().items.map((tenant: { id: string }) => tenant.id);
    expect(ids).toEqual(
      expect.arrayContaining([other.tenantId, operatorTenantId]),
    );

    const current = mine
      .json()
      .items.find((tenant: { current: boolean }) => tenant.current).id;
    const target =
      current === other.tenantId ? operatorTenantId : other.tenantId;
    const switched = await call('POST', '/v1/auth/tenant', headers, {
      tenantId: target,
    });
    expect(switched.statusCode).toBe(204);
    expect(switched.headers['set-cookie']).toBeDefined();

    // The switch rotated the session: the old cookie is gone.
    const rotated = { cookie: cookieOf(switched.headers['set-cookie']) };
    expect((await call('GET', '/v1/auth/tenants', headers)).statusCode).toBe(
      401,
    );
    const stranger = await call('POST', '/v1/auth/tenant', rotated, {
      tenantId: randomUUID(),
    });
    expect(stranger.statusCode).toBe(404);
  });

  it('says what sign-up offers in the sign-in methods', async () => {
    const methods = await call('GET', '/v1/auth/methods', {});
    expect(methods.json()).toMatchObject({
      password: true,
      signUp: true,
      tenantSignUp: true,
    });
  });

  it('lets a tenant’s administrators add and remove its domains', async () => {
    const headers = other.admin.headers;
    const editor = (await member(app, other.tenantId, ['editor'])).headers;
    expect((await call('GET', '/v1/branding/domains', editor)).statusCode).toBe(
      403,
    );
    const bad = await call('POST', '/v1/branding/domains', headers, {
      hostname: '10.0.0.1',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('invalid_hostname');

    const hostname = `app-${randomUUID().slice(0, 8)}.example.com`;
    const added = await call('POST', '/v1/branding/domains', headers, {
      hostname,
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({
      hostname,
      verified: false,
      record: { type: 'TXT', name: `_app-verification.${hostname}` },
    });
    const listed = await call('GET', '/v1/branding/domains', headers);
    expect(
      listed.json().items.map((d: { hostname: string }) => d.hostname),
    ).toContain(hostname);
    expect(
      await app.get(TenantDomainsService).tenantOfHost(hostname),
    ).toBeNull();

    // The branding lock refuses adding and checking, never removing.
    const lock = app.get(BrandingLock);
    lock.locked = true;
    try {
      const refusedAdd = await call('POST', '/v1/branding/domains', headers, {
        hostname: `other-${hostname}`,
      });
      expect(refusedAdd.statusCode).toBe(409);
      expect(refusedAdd.json().code).toBe('branding_locked');
      const refusedCheck = await call(
        'POST',
        `/v1/branding/domains/${added.json().id}/verify`,
        headers,
      );
      expect(refusedCheck.statusCode).toBe(409);
      expect(refusedCheck.json().code).toBe('branding_locked');
    } finally {
      lock.locked = false;
    }

    const removed = await call(
      'DELETE',
      `/v1/branding/domains/${added.json().id}`,
      headers,
    );
    expect(removed.statusCode).toBe(204);
  });
});
