import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../src/core/database/database.js';
import { Tenancy } from '../src/core/tenancy/tenancy.service.js';
import { AccessModule } from '../src/iam/access/access.module.js';
import { roles, userRoles } from '../src/iam/access/access.tables.js';
import { RolesService } from '../src/iam/access/roles.service.js';
import { memberships, users } from '../src/iam/auth/auth.tables.js';
import { OrganizationModule } from '../src/iam/organization/organization.module.js';
import { accessTokenFor, authModules, createUser } from './auth.js';

/**
 * What an e2e test boots to have permissions: the principals (authModules),
 * access control and the organizational units. Set ADMIN_PASSWORD and
 * ADMIN_ONBOARDING=off in the test (vi.hoisted) to use `seededAdmin()`.
 */
export const accessModules = () => [
  ...authModules(),
  AccessModule,
  OrganizationModule,
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

const database = (app: NestNodeApplication) =>
  app.get<Database>(getDrizzleToken());

/** The ids of the tenant's roles by key (`administrator`, `editor`…), in order. */
export async function roleIds(
  app: NestNodeApplication,
  tenantId: string,
  ...keys: string[]
) {
  const rows = await app
    .get(Tenancy)
    .run(tenantId, () =>
      database(app)
        .select({ id: roles.id, key: roles.key })
        .from(roles)
        .where(inArray(roles.key, keys)),
    );
  return keys.map((key) => {
    const row = rows.find((role) => role.key === key);
    if (!row) throw new Error(`No role ${key} in the tenant.`);
    return row.id;
  });
}

/**
 * A member of the tenant holding these roles (keys or ids), with an
 * access token: `app.inject({ ..., headers })` acts as them.
 */
export async function member(
  app: NestNodeApplication,
  tenantId: string,
  roleKeysOrIds: string[] = [],
  options: { email?: string; name?: string } = {},
) {
  const created = await createUser(app, { tenantId, ...options });
  const ids = [
    ...roleKeysOrIds.filter((role) => UUID.test(role)),
    ...(await roleIds(
      app,
      tenantId,
      ...roleKeysOrIds.filter((role) => !UUID.test(role)),
    )),
  ];
  if (ids.length) {
    await app.get(Tenancy).run(tenantId, () =>
      database(app)
        .insert(userRoles)
        .values(ids.map((roleId) => ({ userId: created.user.id, roleId }))),
    );
  }
  const { headers } = await accessTokenFor(app, created.user.id, tenantId);
  return { id: created.user.id, email: created.email, tenantId, headers };
}

/**
 * A new tenant with its roles seeded (as whoever makes a tenant seeds
 * them) and an administrator.
 */
export async function tenantWithAdmin(app: NestNodeApplication) {
  const tenancy = app.get(Tenancy);
  const tenant = await tenancy.create({
    slug: `t-${randomUUID().slice(0, 8)}`,
    name: 'Test tenant',
  });
  await tenancy.run(tenant.id, () =>
    app
      .get(TransactionHost)
      .withTransaction(() => app.get(RolesService).seedTenantRoles()),
  );
  return {
    tenantId: tenant.id,
    admin: await member(app, tenant.id, ['administrator']),
  };
}

/** The first administrator the seed made (ADMIN_EMAIL), with an access token in its tenant. */
export async function seededAdmin(
  app: NestNodeApplication,
  email = 'admin@example.com',
) {
  const [row] = await database(app)
    .select({ id: users.id, tenantId: memberships.tenantId })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(eq(users.email, email));
  if (!row) throw new Error('Not seeded.');
  const { headers } = await accessTokenFor(app, row.id, row.tenantId);
  return { id: row.id, email, tenantId: row.tenantId, headers };
}
