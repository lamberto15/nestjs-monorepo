import { getDrizzleToken } from '@nestjs/drizzle';
import { Module } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import { accessModules } from '../../test/access.js';
import { CheapPasswordsModule } from '../../test/account.js';
import { createUser, signIn } from '../../test/auth.js';
import { bootModules } from '../../test/boot.js';
import type { Database } from '../core/database/database.js';
import { SharedOutboxModule } from '../core/outbox/outbox.module.js';
import { QueuesModule } from '../core/queues/queues.module.js';
import { Tenancy } from '../core/tenancy/tenancy.service.js';
import { AccessModule } from '../iam/access/access.module.js';
import { AccountModule } from '../iam/account/account.module.js';
import { AuditModule } from '../iam/audit/audit.module.js';
import { auditLog } from '../iam/audit/audit.tables.js';
import { TenantsModule } from '../iam/tenants/tenants.module.js';
import { Accounts } from './accounts.service.js';
import { CLI_PERMISSIONS } from './cli.jobs.js';
import { CliError, type Plan } from './plan.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-cli-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    PASSWORD_BREACH_CHECK: 'off',
  });
});

/** What CliModule adds to the app: the plans (the commands only prompt and print). */
@Module({
  imports: [
    AccessModule.forFeature(CLI_PERMISSIONS),
    AuditModule,
    AccountModule,
    TenantsModule,
  ],
  providers: [Accounts],
})
class CliTestModule {}

const operator = { user: 'alice', host: 'server-1' };

describe('operator CLI (e2e)', () => {
  let app: NestNodeApplication;
  let accounts: Accounts;
  let db: Database;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      SharedOutboxModule,
      TenantsModule,
      AccountModule,
      CheapPasswordsModule,
      CliTestModule,
    );
    accounts = app.get(Accounts);
    db = app.get<Database>(getDrizzleToken());
  });
  afterAll(() => app.close());

  /** Plans, then applies, as a command does after the operator confirms. */
  const run = async <T>(planning: Plan<T> | Promise<Plan<T>>) =>
    (await planning).apply(operator);

  const signInStatus = async (email: string, password: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in',
        payload: { email, password },
      })
    ).statusCode;

  const entries = (tenantId: string | null, action: string) =>
    app.get(Tenancy).run(tenantId, () =>
      db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, action), eq(auditLog.actor, 'system:ops')),
        ),
    );

  it('tenant:create makes a tenant and its administrator, who signs in with the one-time password; audited as system:ops', async () => {
    const email = 'first-admin@example.com';
    const plan = accounts.tenantCreate('acme', { name: 'Acme', admin: email });
    expect(plan.summary.join(' ')).toMatch(/Create the tenant "acme"/);
    // Planning writes nothing.
    expect(await signInStatus(email, 'whatever')).not.toBe(200);

    const { tenant, administrator } = await run(plan);
    expect(administrator).toMatchObject({ changed: true, created: true });
    const password = administrator.password!.password;
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(await signInStatus(email, password)).toBe(200);

    const [entry] = await entries(tenant.id, 'ops.tenant-created');
    expect(entry).toMatchObject({
      actor: 'system:ops',
      details: { slug: 'acme', administrator: email, via: 'cli', operator },
    });
    expect(JSON.stringify(entry)).not.toContain(password);

    await expect(
      run(accounts.tenantCreate('acme', { admin: email })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("admin:create keeps an existing account's password, and does nothing twice", async () => {
    const [{ tenant }] = [
      await run(
        accounts.tenantCreate('beta', { admin: 'beta-admin@example.com' }),
      ),
    ];
    const existing = await createUser(app, { email: 'rescue@example.com' });

    const first = await run(
      await accounts.adminCreate(existing.email, { tenant: 'beta' }),
    );
    expect(first).toMatchObject({ changed: true, created: false });
    expect(first.password).toBeUndefined();
    expect(await signInStatus(existing.email, existing.password)).toBe(200);
    expect(await entries(tenant.id, 'ops.admin-created')).toHaveLength(1);

    const again = await run(
      await accounts.adminCreate(existing.email, { tenant: tenant.id }),
    );
    expect(again.changed).toBe(false);
    expect(await entries(tenant.id, 'ops.admin-created')).toHaveLength(1);
  });

  it('refuses an unknown tenant and an invalid address', async () => {
    await expect(
      accounts.adminCreate('x@example.com', { tenant: 'nowhere' }),
    ).rejects.toBeInstanceOf(CliError);
    expect(() =>
      accounts.tenantCreate('t', { admin: 'not-an-address' }),
    ).toThrow(CliError);
  });

  it('user:reset-password sets a one-time password and signs the account out', async () => {
    const user = await createUser(app);
    const { headers } = await signIn(app, user.email, user.password);
    const me = () =>
      app.inject({ method: 'GET', url: '/v1/auth/sessions', headers });
    expect((await me()).statusCode).toBe(200);

    const { password } = await run(await accounts.resetPassword(user.email));
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(await signInStatus(user.email, user.password)).not.toBe(200);
    expect(await signInStatus(user.email, password)).toBe(200);
    expect((await me()).statusCode).toBe(401);

    const [entry] = await entries(null, 'ops.password-reset');
    expect(entry).toMatchObject({ details: { via: 'cli', operator } });
    expect(
      JSON.stringify(await entries(null, 'ops.password-reset')),
    ).not.toContain(password);
    await expect(
      accounts.resetPassword('nobody@example.com'),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('user:remove-mfa and user:unlock are audited', async () => {
    const user = await createUser(app);
    await run(await accounts.removeMfa(user.email));
    expect(await entries(null, 'ops.mfa-removed')).toHaveLength(1);
    const unlocked = await run(await accounts.unlock(user.email));
    expect(unlocked).toEqual({ email: user.email, failures: 0 });
    expect(await entries(null, 'ops.user-unlocked')).toHaveLength(1);
  });

  it('tenant:list shows the tenants with their members', async () => {
    const list = await accounts.tenantList();
    expect(list.find((tenant) => tenant.slug === 'acme')).toMatchObject({
      active: true,
      members: 1,
    });
  });
});
