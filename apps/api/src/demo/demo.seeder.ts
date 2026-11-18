import { randomBytes } from 'node:crypto';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { PasswordHasher } from '@nestjs/authentication';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { asc, eq, like, min } from 'drizzle-orm';
import type { Database } from '../core/database/database.js';
import { tenancyConfig } from '../core/tenancy/tenancy.config.js';
import { Tenancy } from '../core/tenancy/tenancy.service.js';
import { type Tenant, tenants } from '../core/tenancy/tenancy.tables.js';
import { roles, userRoles } from '../iam/access/access.tables.js';
import { SystemContext } from '../iam/access/system-context.js';
import { AuditService } from '../iam/audit/audit.service.js';
import { memberships, users } from '../iam/auth/auth.tables.js';
import { UsersRepository } from '../iam/auth/users.repository.js';
import { OrganizationService } from '../iam/organization/organization.service.js';
import { TenantsService } from '../iam/tenants/tenants.service.js';
import {
  DEMO_EMAIL_DOMAIN,
  DEMO_TENANT,
  DEMO_UNITS,
  DEMO_USERS,
} from './demo.data.js';
import {
  DemoSeedRefused,
  isDevDatabase,
  markerRefusal,
  nodeEnvRefusal,
} from './demo.guard.js';
import { DEMO_SEED_JOB } from './demo.jobs.js';

/** A demo user's sign-in, shown once: only its hash is kept. */
export interface DemoCredentials {
  email: string;
  name: string;
  roles: string[];
  password: string;
}

export type DemoSeedResult =
  | {
      seeded: true;
      tenant: string;
      /** TENANCY=single: the seed filled the operators' tenant, the only one. */
      operators: boolean;
      units: number;
      users: DemoCredentials[];
    }
  | { seeded: false; since: Date };

/** A demo user's address: `maya.patel@demo.example.com`. */
const demoEmail = (name: string) =>
  `${name.toLowerCase().replace(/\s+/g, '.')}@${DEMO_EMAIL_DOMAIN}`;

/**
 * The demo data (demo.data.ts), written through the services an
 * administrator's requests go through, as the system principal
 * `system:demo-seed`: the tenant and its roles (TenantsService.makeTenant),
 * the units (OrganizationService, audited), and the people. A person is made
 * here, directly: adding people is invite-only through the API, and the demo
 * needs accounts with a known sign-in. Passwords are generated and returned
 * once (a fixed one would be in every breach list); only hashes are kept.
 *
 * - **Only on a development database** (demo.guard.ts): NODE_ENV and the
 *   database's marker, both checked before anything is written.
 * - **Once:** a database that has the demo tenant or demo users is left as
 *   it is (`seeded: false`). The tenant is made with its roles in one
 *   transaction (and deleted again when what follows fails).
 * - **TENANCY=single:** there is no tenant to add; the one there is (the
 *   operators', made by the first start) is filled, and the demo
 *   administrator acts as an operator there.
 *
 * The operators' tenant and its first administrator are not made here: the
 * first start of any process makes them (iam/access, AccessSeeder).
 */
@Injectable()
export class DemoSeeder {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly tenancy: Tenancy,
    private readonly tenantsService: TenantsService,
    private readonly system: SystemContext,
    private readonly organization: OrganizationService,
    private readonly usersRepository: UsersRepository,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasher,
    @Inject(tenancyConfig.KEY)
    private readonly tenancyMode: ConfigType<typeof tenancyConfig>,
  ) {}

  async seed(): Promise<DemoSeedResult> {
    // Read at the call, as set (demo.guard.ts), not through the config.
    const refused = nodeEnvRefusal(process.env.NODE_ENV);
    if (refused) throw new DemoSeedRefused(refused);

    const unmarked = markerRefusal(
      await this.tenancy.run(null, () => isDevDatabase(this.db)),
    );
    if (unmarked) throw new DemoSeedRefused(unmarked);

    const since = await this.seededSince();
    if (since) return { seeded: false, since };

    // Hashed before any transaction: scrypt is slow, a transaction is not.
    const credentials = await Promise.all(
      DEMO_USERS.map(async (user) => {
        const password = randomBytes(18).toString('base64url');
        return {
          user,
          password,
          email: demoEmail(user.name),
          hash: await this.hasher.hash(password),
        };
      }),
    );
    const single = this.tenancyMode.mode === 'single';
    const fill = (tenant: Tenant) =>
      this.system.run(DEMO_SEED_JOB, () => this.fill(tenant, credentials), {
        tenantId: tenant.id,
      });
    const { tenant, result } = single
      ? await this.theTenant().then(async (tenant) => ({
          tenant,
          result: await fill(tenant),
        }))
      : await this.tenantsService.makeTenant(DEMO_TENANT, fill);
    return {
      seeded: true,
      tenant: tenant.name,
      operators: single,
      units: DEMO_UNITS.length,
      users: result,
    };
  }

  /** When the demo was seeded (its tenant or its users, accounts being global), or null. */
  private async seededSince(): Promise<Date | null> {
    return this.tenancy.run(null, async () => {
      const [tenant] = await this.db
        .select({ createdAt: tenants.createdAt })
        .from(tenants)
        .where(eq(tenants.slug, DEMO_TENANT.slug));
      const [first] = await this.db
        .select({ first: min(users.createdAt) })
        .from(users)
        .where(like(users.email, `%@${DEMO_EMAIL_DOMAIN}`));
      return tenant?.createdAt ?? first?.first ?? null;
    });
  }

  /** TENANCY=single's one tenant. */
  private async theTenant(): Promise<Tenant> {
    const [tenant] = await this.tenancy.run(null, () =>
      this.db.select().from(tenants).orderBy(asc(tenants.createdAt)).limit(1),
    );
    if (!tenant) {
      throw new DemoSeedRefused(
        'TENANCY=single has no tenant yet: start the API or the worker once (the first start makes it).',
      );
    }
    return tenant;
  }

  /** In the tenant's transaction, as the demo job. */
  private async fill(
    tenant: Tenant,
    people: {
      user: (typeof DEMO_USERS)[number];
      email: string;
      password: string;
      hash: string;
    }[],
  ): Promise<DemoCredentials[]> {
    const system = this.system.principal(DEMO_SEED_JOB);
    const tenantRoles = await this.db
      .select({ id: roles.id, key: roles.key, name: roles.name })
      .from(roles);
    const role = (key: string) => {
      const found = tenantRoles.find((candidate) => candidate.key === key);
      if (!found) {
        throw new Error(
          `The demo seed gives the role "${key}", which isn't seeded: change DEMO_USERS (demo.data.ts).`,
        );
      }
      return found;
    };

    const unitIds = new Map<string, string>();
    for (const unit of DEMO_UNITS) {
      const created = await this.organization.create(system, {
        type: unit.type,
        name: unit.name,
        parentId: unit.parent ? unitIds.get(unit.parent) : null,
      });
      unitIds.set(unit.key, created.id);
    }

    const made: { id: string; person: (typeof people)[number] }[] = [];
    for (const person of people) {
      const [user] = await this.db
        .insert(users)
        .values({
          email: person.email,
          name: person.user.name,
          passwordHash: person.hash,
          emailVerified: true,
        })
        .returning({ id: users.id });
      await this.db
        .insert(memberships)
        .values({ tenantId: tenant.id, userId: user!.id });
      await this.db.insert(userRoles).values(
        person.user.roles.map((key) => ({
          userId: user!.id,
          roleId: role(key).id,
        })),
      );
      made.push({ id: user!.id, person });
    }

    // Placed as the demo administrator would: the units' own service, audited.
    const administrator = made.find(({ person }) =>
      person.user.roles.includes('administrator'),
    );
    const actor = administrator
      ? await this.usersRepository.inTenant(administrator.id, tenant.id)
      : null;
    if (!actor) throw new Error('The demo has no administrator.');
    for (const { id, person } of made) {
      for (const key of person.user.units) {
        await this.organization.addMember(actor, unitIds.get(key)!, {
          userId: id,
          role: person.user.leads?.includes(key) ? 'lead' : 'member',
        });
      }
    }

    await this.audit.record(system, {
      action: 'demo.seeded',
      targetType: 'tenant',
      targetId: tenant.id,
      details: { users: people.map(({ email }) => email) },
    });
    return people.map(({ user, email, password }) => ({
      email,
      name: user.name,
      roles: user.roles.map((key) => role(key).name),
      password,
    }));
  }
}
