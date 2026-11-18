import { getDrizzleToken } from '@nestjs/drizzle';
import { OutboxRelay } from '@nestjs/outbox';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { StorageDisk } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import { accessModules, tenantWithAdmin } from '../../../test/access.js';
import { CheapPasswordsModule } from '../../../test/account.js';
import { createUser } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { SharedOutboxModule } from '../../core/outbox/outbox.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccountModule } from '../../iam/account/account.module.js';
import { HoldsModule } from '../../iam/holds/holds.module.js';
import { AccountDeletionJob } from '../../iam/personal-data/account-deletion.job.js';
import { PersonalDataModule } from '../../iam/personal-data/personal-data.module.js';
import { accountDeletions } from '../../iam/personal-data/personal-data.tables.js';
import { SignUpSweepJob } from '../../iam/tenants/sign-up-sweep.job.js';
import { TenantDeletionJob } from '../../iam/tenants/tenant-deletion.job.js';
import { TenantsModule } from '../../iam/tenants/tenants.module.js';
import { tenantLifecycle } from '../../iam/tenants/tenants.tables.js';
import { accountFileKey, tenantFileKey } from './storage.keys.js';
import { StorageModule } from './storage.module.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    OUTBOX_RELAY: 'off',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    MAIL_TRANSPORT: 'memory',
    PASSWORD_BREACH_CHECK: 'off',
    OPERATOR_TENANT: `ops-${process.pid}-${Date.now()}`,
    REDIS_PREFIX: `test-storage-erasure-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  });
});

const DAY = 86_400_000;

describe('storage: what is erased takes its files (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let disk: StorageDisk;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      SharedOutboxModule,
      StorageModule,
      TenantsModule,
      AccountModule,
      HoldsModule,
      PersonalDataModule,
      CheapPasswordsModule,
    );
    db = app.get<Database>(getDrizzleToken());
    disk = app.get(StorageDisk);
  });
  afterAll(() => app?.close());

  const inNoTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(null, work);
  /** Everything committed is delivered (the relay is off in this file). */
  const relay = async () => {
    await app.get(OutboxRelay).runOnce();
    await app.get(OutboxRelay).runOnce();
  };
  const put = async (...keys: string[]) => {
    for (const key of keys) await disk.put(key, Buffer.from(key));
  };
  const exists = async (...keys: string[]) =>
    Promise.all(keys.map((key) => disk.exists(key)));

  it("erases a tenant's files with the tenant once its deletion is due, and no other tenant's", async () => {
    const { tenantId } = await tenantWithAdmin(app);
    const other = await tenantWithAdmin(app);
    const mine = [
      tenantFileKey(tenantId, 'branding/logo-light.png'),
      tenantFileKey(tenantId, 'attachments/a/b.pdf'),
    ];
    const theirs = tenantFileKey(other.tenantId, 'branding/logo-light.png');
    await put(...mine, theirs);
    await inNoTenant(() =>
      db.insert(tenantLifecycle).values({
        tenantId,
        deletionRequestedAt: new Date(Date.now() - 40 * DAY),
        deletionScheduledFor: new Date(Date.now() - DAY),
      }),
    );

    expect(await app.get(TenantDeletionJob).eraseDue()).toBe(1);
    expect(await app.get(Tenancy).find(tenantId)).toBeUndefined();
    await relay();

    expect(await exists(...mine)).toEqual([false, false]);
    expect(await disk.exists(theirs)).toBe(true);
  });

  it("erases an unverified sign-up's tenant's files with it", async () => {
    const tenant = await app
      .get(Tenancy)
      .create({ slug: `s-${Date.now()}`, name: 'Sign-up' });
    await inNoTenant(() =>
      db
        .insert(tenantLifecycle)
        .values({ tenantId: tenant.id, createdBySignUp: true }),
    );
    const key = tenantFileKey(tenant.id, 'branding/logo-dark.png');
    await put(key);

    expect(
      await app.get(SignUpSweepJob).sweep(new Date(Date.now() + 8 * DAY)),
    ).toBeGreaterThanOrEqual(1);
    expect(await app.get(Tenancy).find(tenant.id)).toBeUndefined();
    await relay();

    expect(await disk.exists(key)).toBe(false);
  });

  it("erases an account's files (its picture, its data exports) with the account, and no one else's", async () => {
    const { user } = await createUser(app);
    const other = await createUser(app);
    const mine = [
      accountFileKey(user.id, 'avatar/one.png'),
      accountFileKey(user.id, 'exports/export.json'),
    ];
    const theirs = accountFileKey(other.user.id, 'exports/export.json');
    await put(...mine, theirs);
    await inNoTenant(() =>
      db
        .insert(accountDeletions)
        .values({ userId: user.id, scheduledFor: new Date(Date.now() - DAY) }),
    );

    expect(await app.get(AccountDeletionJob).deleteDue()).toBe(1);
    const [deletion] = await inNoTenant(() =>
      db
        .select()
        .from(accountDeletions)
        .where(eq(accountDeletions.userId, user.id)),
    );
    expect(deletion?.completedAt).toBeTruthy();
    await relay();

    expect(await exists(...mine)).toEqual([false, false]);
    expect(await disk.exists(theirs)).toBe(true);
  });
});
