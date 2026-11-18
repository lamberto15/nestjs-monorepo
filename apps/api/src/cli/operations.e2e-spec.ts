import { getDrizzleToken } from '@nestjs/drizzle';
import { Module } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import { accessModules, member, tenantWithAdmin } from '../../test/access.js';
import { CheapPasswordsModule } from '../../test/account.js';
import { bootModules } from '../../test/boot.js';
import type { Database } from '../core/database/database.js';
import { SharedLocksModule } from '../core/locks/locks.module.js';
import { SharedOutboxModule } from '../core/outbox/outbox.module.js';
import { QueuesModule } from '../core/queues/queues.module.js';
import { SecretsModule } from '../core/secrets/secrets.module.js';
import { Tenancy } from '../core/tenancy/tenancy.service.js';
import { SharedWorkflowsModule } from '../core/workflows/workflows.module.js';
import { AccessModule } from '../iam/access/access.module.js';
import { AccountModule } from '../iam/account/account.module.js';
import { AuditModule } from '../iam/audit/audit.module.js';
import { auditLog } from '../iam/audit/audit.tables.js';
import { TenantsModule } from '../iam/tenants/tenants.module.js';
import { NotificationsModule } from '../modules/notifications/notifications.module.js';
import { notifications } from '../modules/notifications/notifications.tables.js';
import { OpsModule } from '../modules/ops/ops.module.js';
import { SettingsModule } from '../modules/settings/settings.module.js';
import { Accounts } from './accounts.service.js';
import { CLI_PERMISSIONS } from './cli.jobs.js';
import { Operations } from './operations.service.js';
import { CliError } from './plan.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-cli-ops-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    PASSWORD_BREACH_CHECK: 'off',
  });
});

/** What CliModule adds to the app for these commands. */
@Module({
  imports: [
    AccessModule.forFeature(CLI_PERMISSIONS),
    AuditModule,
    AccountModule,
    TenantsModule,
    OpsModule,
    SettingsModule,
    NotificationsModule,
  ],
  providers: [Accounts, Operations],
})
class CliTestModule {}

const operator = { user: 'alice', host: 'server-1' };

describe('operator CLI: users, settings, notifications, backlog (e2e)', () => {
  let app: NestNodeApplication;
  let accounts: Accounts;
  let operations: Operations;
  let tenantId: string;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      SecretsModule,
      SharedLocksModule,
      SharedOutboxModule,
      SharedWorkflowsModule,
      CheapPasswordsModule,
      CliTestModule,
    );
    accounts = app.get(Accounts);
    operations = app.get(Operations);
    tenantId = (await tenantWithAdmin(app)).tenantId;
  });
  afterAll(() => app?.close());

  const db = () => app.get<Database>(getDrizzleToken());
  const entries = (id: string | null, action: string) =>
    app.get(Tenancy).run(id, () =>
      db()
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, action), eq(auditLog.actor, 'system:ops')),
        ),
    );

  it("user:list shows a tenant's members with their roles and second factor", async () => {
    const editor = await member(app, tenantId, ['editor']);
    const { members } = await accounts.userList(tenantId);
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: editor.email,
          roles: ['editor'],
          mfa: false,
          accountActive: true,
        }),
        expect.objectContaining({ roles: ['administrator'] }),
      ]),
    );
    await expect(accounts.userList('nobody')).rejects.toThrow(CliError);
  });

  it("notifications:settle marks a person's undelivered notifications delivered and read, audited", async () => {
    const person = await member(app, tenantId, []);
    const recipient = `user:${person.id}`;
    await app.get(Tenancy).run(tenantId, () =>
      db()
        .insert(notifications)
        .values([
          { recipient, type: 'storm.noise', data: {} },
          { recipient, type: 'storm.noise', data: {} },
        ]),
    );
    const plan = await operations.notificationsSettle(person.email, {});
    expect(plan.summary.join(' ')).toContain('2 notification(s)');
    const result = await plan.apply(operator);
    expect(result.notifications).toBe(2);

    const rows = await app
      .get(Tenancy)
      .run(tenantId, () =>
        db()
          .select()
          .from(notifications)
          .where(eq(notifications.recipient, recipient)),
      );
    expect(rows.every((row) => row.deliveredAt && row.readAt)).toBe(true);
    expect(
      (
        await (
          await operations.notificationsSettle(person.email, {})
        ).apply(operator)
      ).notifications,
    ).toBe(0);
    const [entry] = await entries(null, 'ops.notifications-settled');
    expect(entry).toMatchObject({
      details: { notifications: 2, via: 'cli', operator },
    });
  });

  it('backlog:* names a scope, refuses mail by tenant, and audits what it did', async () => {
    await expect(
      operations.backlogAction('discard', 'outbox', {}),
    ).rejects.toThrow(CliError);
    await expect(
      operations.backlogAction('discard', 'outbox', {
        tenant: 'x',
        global: true,
      }),
    ).rejects.toThrow(CliError);
    await expect(
      operations.backlogAction('discard', 'tapes', { global: true }),
    ).rejects.toThrow(/outbox or mail/);

    const tenant = await accounts.tenant(tenantId);
    const discard = await operations.backlogAction('discard', 'outbox', {
      tenant: tenant.slug,
    });
    expect(discard.summary.join(' ')).toContain(tenant.slug);
    expect(await discard.apply(operator)).toEqual({ count: 0, more: false });
    const [entry] = await entries(tenantId, 'ops.backlog-discarded');
    expect(entry).toMatchObject({
      details: { scope: tenant.slug, count: 0, via: 'cli' },
    });

    const mail = await operations.backlogAction('retry', 'mail', {
      tenant: tenant.slug,
    });
    await expect(mail.apply(operator)).rejects.toMatchObject({
      response: { code: 'mail_not_tenant_scoped' },
    });
    const counted = await operations.backlogCount({ tenant: tenant.slug });
    expect(counted.outbox.pending.total).toBe(0);
  });

  it('setting:delete needs exactly one place and a known setting', async () => {
    await expect(operations.settingDelete('app.name', {})).rejects.toThrow(
      CliError,
    );
    await expect(
      operations.settingDelete('app.name', { tenant: 'x', platform: true }),
    ).rejects.toThrow(CliError);
    const plan = await operations.settingDelete('no.such.setting', {
      platform: true,
    });
    await expect(plan.apply(operator)).rejects.toThrow(CliError);
  });
});
