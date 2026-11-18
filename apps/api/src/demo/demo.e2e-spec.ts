import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { count, eq } from 'drizzle-orm';
import { inject } from 'vitest';
import { accessModules } from '../../test/access.js';
import { signIn } from '../../test/auth.js';
import { bootModules } from '../../test/boot.js';
import { databaseUrl, onServer } from '../../test/postgres.js';
import type { Database } from '../core/database/database.js';
import { SharedOutboxModule } from '../core/outbox/outbox.module.js';
import { QueuesModule } from '../core/queues/queues.module.js';
import { Tenancy } from '../core/tenancy/tenancy.service.js';
import { tenants } from '../core/tenancy/tenancy.tables.js';
import { TenantsModule } from '../iam/tenants/tenants.module.js';
import { organizationalUnitMemberships } from '../iam/organization/organization.tables.js';
import { DEMO_TENANT, DEMO_UNITS, DEMO_USERS } from './demo.data.js';
import { DemoSeedRefused } from './demo.guard.js';
import { DemoModule } from './demo.module.js';
import { DemoSeeder } from './demo.seeder.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    REDIS_PREFIX: `test-demo-${process.pid}-${Date.now()}`,
    MAIL_TRANSPORT: 'memory',
  });
});

describe('the demo seed (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      SharedOutboxModule,
      TenantsModule,
      DemoModule,
    );
  });
  afterAll(() => app.close());

  it('refuses a database that is not marked as a development one, and writes nothing', async () => {
    const db = app.get<Database>(getDrizzleToken());
    await expect(app.get(DemoSeeder).seed()).rejects.toThrow(DemoSeedRefused);
    const found = await app
      .get(Tenancy)
      .run(null, () =>
        db.select().from(tenants).where(eq(tenants.slug, DEMO_TENANT.slug)),
      );
    expect(found).toEqual([]);
  });

  it('on a marked database makes the tenant, units and people once, with working sign-ins', async () => {
    const name = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    await onServer(
      databaseUrl(inject('postgresUrl'), name),
      `alter database "${name}" set app.dev_database = 'on'`,
    );
    const seeded = await app.get(DemoSeeder).seed();
    if (!seeded.seeded) throw new Error('Not seeded.');
    expect(seeded.tenant).toBe(DEMO_TENANT.name);
    expect(seeded.users).toHaveLength(DEMO_USERS.length);
    expect(seeded.users[0]!.roles).toEqual(['Administrator', 'Editor']);

    // People are in their units, leads as leads.
    const db = app.get<Database>(getDrizzleToken());
    const [{ n }] = await app
      .get(Tenancy)
      .run(
        (
          await app
            .get(Tenancy)
            .run(null, () =>
              db
                .select()
                .from(tenants)
                .where(eq(tenants.slug, DEMO_TENANT.slug)),
            )
        )[0]!.id,
        () => db.select({ n: count() }).from(organizationalUnitMemberships),
      );
    expect(n).toBe(
      DEMO_USERS.reduce((sum, user) => sum + user.units.length, 0),
    );
    expect(DEMO_UNITS.length).toBe(seeded.units);

    // The shown password signs in.
    const { email, password } = seeded.users[0]!;
    await expect(signIn(app, email, password)).resolves.toBeDefined();

    // Once: a second run changes nothing.
    await expect(app.get(DemoSeeder).seed()).resolves.toMatchObject({
      seeded: false,
    });
  });
});
