import { randomBytes } from 'node:crypto';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import type { ConfigType } from '@nestjs/config';
import { and, asc, eq, sql } from 'drizzle-orm';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { tenancyConfig } from '../../core/tenancy/tenancy.config.js';
import { type Tenant, tenants } from '../../core/tenancy/tenancy.tables.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../audit/audit.service.js';
import { authConfig } from '../auth/auth.config.js';
import { memberships, users } from '../auth/auth.tables.js';
import { isPlaceholderEmail } from '../auth/onboarding.js';
import { normalizeEmail } from '../auth/users.repository.js';
import { accessConfig } from './access.config.js';
import { SEED_JOB } from './access.permissions.js';
import { userRoles } from './access.tables.js';
import { RolesService } from './roles.service.js';
import { SystemContext } from './system-context.js';

/**
 * On a deployment's first start (no user yet): the first tenant (the
 * operators', OPERATOR_TENANT or made from ADMIN_TENANT_NAME; with
 * TENANCY=single the one tenant) with Administrator and the declared seed
 * roles, and the first administrator, its member, from ADMIN_EMAIL and
 * ADMIN_PASSWORD (generated and logged once when unset). As the system
 * principal (`system:seed`), the actor of its `user.seeded` entry. Later
 * starts change nothing but one thing: an administrator still on the
 * placeholder ADMIN_EMAIL is flagged for onboarding.
 */
@Injectable()
export class AccessSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger('Access');

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly system: SystemContext,
    private readonly roles: RolesService,
    private readonly audit: AuditService,
    private readonly passwordHasher: PasswordHasher,
    @Inject(accessConfig.KEY)
    private readonly config: ConfigType<typeof accessConfig>,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
    @Inject(tenancyConfig.KEY)
    private readonly tenancyMode: ConfigType<typeof tenancyConfig>,
  ) {}

  async onApplicationBootstrap() {
    if (await this.anyUser()) {
      await this.requirePlaceholderOnboarding();
      return;
    }
    const configured = this.config.adminPassword;
    const password = configured || randomBytes(18).toString('base64url');
    // scrypt before the lock: the lock is held for milliseconds, not a hash.
    const passwordHash = await this.passwordHasher.hash(password);
    const email = normalizeEmail(this.config.adminEmail);
    const onboarding = this.config.adminOnboarding;
    const tenant = await this.firstTenant();
    const seeded = await this.system.run(
      SEED_JOB,
      async (system) => {
        // Every process of a first start runs this at once: exactly one
        // seeds, the others find it done.
        await this.db.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('access:seed', 0))`,
        );
        const taken = await this.db
          .select({ id: users.id })
          .from(users)
          .limit(1);
        if (taken.length > 0) return false;
        const { administratorId } = await this.roles.seedTenantRoles();
        const [user] = await this.db
          .insert(users)
          .values({
            email,
            name: 'Administrator',
            passwordHash,
            emailVerified: true,
            // The first sign-in must replace a placeholder address and a
            // generated password (OnboardingGuard).
            onboardingEmail: onboarding && isPlaceholderEmail(email),
            onboardingPassword: onboarding && !configured,
          })
          .returning({ id: users.id });
        await this.db
          .insert(memberships)
          .values({ tenantId: tenant.id, userId: user!.id });
        await this.db
          .insert(userRoles)
          .values({ userId: user!.id, roleId: administratorId });
        await this.audit.record(system, {
          action: 'user.seeded',
          targetType: 'user',
          targetId: user!.id,
          details: { email, tenant: tenant.slug },
        });
        return true;
      },
      { tenantId: tenant.id },
    );
    if (seeded) {
      this.logger.log(
        `Seeded the tenant "${tenant.name}" and its roles: ${[
          'administrator',
          ...this.roles.seedRoleKeys(),
        ].join(', ')}.`,
      );
      this.logger.warn(
        configured
          ? `Created the first administrator ${email} (password from ADMIN_PASSWORD).`
          : `Created the first administrator ${email} with password ${password} (shown once; set ADMIN_PASSWORD to choose it, and change it after signing in).`,
      );
    }
  }

  /**
   * The tenant the first administrator joins: TENANCY=single's one (made
   * here if Tenancy hasn't yet), else the operators' by slug, made when
   * missing. Instances starting together: the slug's unique key keeps it one.
   */
  private async firstTenant(): Promise<Tenant> {
    const single = this.tenancyMode.mode === 'single';
    const slug = single
      ? 'default'
      : (this.auth.operatorTenant ?? slugOf(this.config.adminTenantName));
    return this.tenancy.run(null, async () => {
      const existing = single
        ? await this.db
            .select()
            .from(tenants)
            .orderBy(asc(tenants.createdAt))
            .limit(1)
        : await this.db.select().from(tenants).where(eq(tenants.slug, slug));
      if (existing[0]) return existing[0];
      try {
        return await this.tenancy.create({
          slug,
          name: single ? 'Default' : this.config.adminTenantName,
        });
      } catch (error) {
        if (databaseErrorKind(error) !== 'unique_violation') throw error;
        const [made] = await this.db
          .select()
          .from(tenants)
          .where(eq(tenants.slug, slug));
        return made!;
      }
    });
  }

  /**
   * The administrator seeded on the placeholder ADMIN_EMAIL while
   * onboarding was off, since turned on: flagged so their next request
   * asks for a real address. Only the verified account on exactly that
   * address; once changed nothing matches. One idempotent statement.
   */
  private async requirePlaceholderOnboarding() {
    const email = normalizeEmail(this.config.adminEmail);
    if (!this.config.adminOnboarding || !isPlaceholderEmail(email)) return;
    const flagged = await this.system.run(
      SEED_JOB,
      async (system) => {
        const rows = await this.db
          .update(users)
          .set({ onboardingEmail: true })
          .where(
            and(
              eq(users.email, email),
              eq(users.emailVerified, true),
              eq(users.onboardingEmail, false),
            ),
          )
          .returning({ id: users.id });
        for (const { id } of rows) {
          await this.audit.record(system, {
            action: 'user.onboarding-required',
            targetType: 'user',
            targetId: id,
            details: { email },
          });
        }
        return rows.length;
      },
      { tenantId: null },
    );
    if (flagged > 0) {
      this.logger.warn(
        `The administrator ${email} still has the placeholder address: its next sign-in asks for a real one (ADMIN_ONBOARDING=off to skip).`,
      );
    }
  }

  /** Whether any account exists: one row read, not a count. */
  private async anyUser() {
    const rows = await this.tenancy.run(null, () =>
      this.db.select({ id: users.id }).from(users).limit(1),
    );
    return rows.length > 0;
  }
}

/** A tenant's handle from its name: `Acme Corp` → `acme-corp`. */
export const slugOf = (name: string) =>
  name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'tenant';
