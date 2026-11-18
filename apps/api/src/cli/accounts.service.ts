import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  PasswordHasher,
  SessionService,
  TokenService,
} from '@nestjs/authentication';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { Database } from '../core/database/database.js';
import { Tenancy } from '../core/tenancy/tenancy.service.js';
import { type Tenant, tenants } from '../core/tenancy/tenancy.tables.js';
import { roles, userRoles } from '../iam/access/access.tables.js';
import { SystemContext } from '../iam/access/system-context.js';
import { AccountOperations } from '../iam/account/account.operations.js';
import { ADMINISTRATOR_ROLE } from '../iam/access/roles.service.js';
import { AuditService } from '../iam/audit/audit.service.js';
import { mfaAuthenticators } from '../iam/account/account.tables.js';
import { memberships, users } from '../iam/auth/auth.tables.js';
import { normalizeEmail } from '../iam/auth/users.repository.js';
import { TenantsService } from '../iam/tenants/tenants.service.js';
import { OPS_JOB } from './cli.jobs.js';
import {
  by,
  CliError,
  type OneTimePassword,
  oneTimePassword,
  type Plan,
} from './plan.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Something@something.something, no whitespace, one `@`; linear time. */
const EMAIL = /^[^\s@]+@[^\s@][^\s@.]*\.[^\s@]+$/;

/**
 * The account and tenant commands as plans over iam's own services, so a
 * password is hashed, sessions and tokens ended and the owner told as the
 * API does it. Every write runs as `system:ops` (cli.jobs.ts) in the tenant
 * it is about, in one transaction with its audit entry naming the operator.
 *
 * It uses what iam/account (AccountOperations) and iam/tenants
 * (TenantsService) export; it lives in src/cli because it composes the app.
 */
@Injectable()
export class Accounts {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly accountOps: AccountOperations,
    private readonly tenantsService: TenantsService,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
  ) {}

  /** Work on global tables (accounts, tenants, memberships): in no tenant. */
  private global<T>(work: () => Promise<T>) {
    return this.tenancy.run(null, work);
  }

  private email(input: string) {
    const email = normalizeEmail(input);
    if (!EMAIL.test(email)) {
      throw new CliError(`"${input}" is not an email address.`);
    }
    return email;
  }

  /** A tenant by id or slug. */
  async tenant(ref: string): Promise<Tenant> {
    const [found] = await this.global(() =>
      this.db
        .select()
        .from(tenants)
        .where(UUID.test(ref) ? eq(tenants.id, ref) : eq(tenants.slug, ref)),
    );
    if (!found) {
      throw new CliError(`No tenant "${ref}": see tenant:list.`);
    }
    return found;
  }

  private async account(email: string) {
    const [user] = await this.global(() =>
      this.db
        .select({ id: users.id, name: users.name, active: users.active })
        .from(users)
        .where(eq(users.email, email)),
    );
    if (!user) {
      throw new CliError(`No account ${email}.`);
    }
    return user;
  }

  /** An account by address (normalised and checked); a CliError when there is none. */
  userByEmail(input: string) {
    const email = this.email(input);
    return this.account(email).then((user) => ({ ...user, email }));
  }

  /** A tenant's members: roles, second factor, whether they can sign in. */
  async userList(tenantRef: string) {
    const tenant = await this.tenant(tenantRef);
    const members = await this.system.run(
      OPS_JOB,
      async () => {
        const rows = await this.db
          .select({
            id: users.id,
            email: users.email,
            accountActive: users.active,
            membershipActive: memberships.active,
          })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(eq(memberships.tenantId, tenant.id))
          .orderBy(asc(users.email));
        const ids = rows.map((row) => row.id);
        if (ids.length === 0) return [];
        // Roles are tenant tables: read in the tenant's scope (the job's).
        const grants = await this.db
          .select({
            userId: userRoles.userId,
            key: roles.key,
            name: roles.name,
          })
          .from(userRoles)
          .innerJoin(roles, eq(roles.id, userRoles.roleId))
          .where(inArray(userRoles.userId, ids));
        const enrolled = await this.db
          .select({ userId: mfaAuthenticators.id })
          .from(mfaAuthenticators)
          .where(
            and(
              inArray(mfaAuthenticators.id, ids),
              eq(mfaAuthenticators.confirmed, true),
            ),
          );
        return rows.map((row) => ({
          ...row,
          roles: grants
            .filter((grant) => grant.userId === row.id)
            .map((grant) => grant.key ?? grant.name),
          mfa: enrolled.some((entry) => entry.userId === row.id),
        }));
      },
      { tenantId: tenant.id },
    );
    return { tenant, members };
  }

  /** Every tenant, with its active members. */
  tenantList() {
    return this.global(async () => {
      const rows = await this.db
        .select({
          id: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          active: tenants.active,
          frozenAt: tenants.frozenAt,
        })
        .from(tenants)
        .orderBy(asc(tenants.slug));
      const members = await this.db
        .select({ tenantId: memberships.tenantId, members: count() })
        .from(memberships)
        .where(eq(memberships.active, true))
        .groupBy(memberships.tenantId);
      return rows.map(({ frozenAt, ...row }) => ({
        ...row,
        frozen: frozenAt !== null,
        members: members.find((m) => m.tenantId === row.id)?.members ?? 0,
      }));
    });
  }

  /**
   * In the current tenant's transaction: makes `email` its administrator. A
   * new address gets a verified account with a one-time password; an
   * existing account keeps its password. Returns what happened.
   */
  private async makeAdministrator(email: string, name: string | undefined) {
    const [existing] = await this.db
      .select({ id: users.id, active: users.active })
      .from(users)
      .where(eq(users.email, email));
    if (existing && !existing.active) {
      throw new CliError(
        `The account ${email} is deactivated: nothing to make an administrator of.`,
      );
    }
    let userId = existing?.id;
    let password: OneTimePassword | undefined;
    if (!userId) {
      const generated = oneTimePassword();
      const [created] = await this.db
        .insert(users)
        .values({
          email,
          name: name?.trim() || email.split('@')[0]!,
          passwordHash: await this.hasher.hash(generated),
          emailVerified: true,
        })
        .returning({ id: users.id });
      userId = created!.id;
      password = { email, password: generated };
    } else if (await this.isAdministrator(userId)) {
      return { userId, changed: false, created: false };
    }
    await this.tenantsService.addAdministrator(userId);
    return { userId, changed: true, created: !existing, password };
  }

  private async isAdministrator(userId: string) {
    const [row] = await this.db
      .select({ id: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(
        and(eq(userRoles.userId, userId), eq(roles.key, ADMINISTRATOR_ROLE)),
      );
    return Boolean(row);
  }

  /** A tenant and its first administrator, with a one-time password when the account is new. */
  tenantCreate(
    slug: string,
    options: { name?: string; admin: string },
  ): Plan<{
    tenant: Tenant;
    administrator: Awaited<ReturnType<Accounts['makeAdministrator']>>;
  }> {
    const email = this.email(options.admin);
    const name = options.name?.trim() || slug;
    return {
      summary: [
        `Create the tenant "${slug}" (${name}) with its roles, and ${email} as its administrator (a new account gets a one-time password, shown once).`,
      ],
      apply: async (operator) => {
        const { tenant, result } = await this.tenantsService.makeTenant(
          { name, slug },
          async (made) => {
            const administrator = await this.makeAdministrator(
              email,
              undefined,
            );
            await this.audit.record(this.system.principal(OPS_JOB), {
              action: 'ops.tenant-created',
              targetType: 'tenant',
              targetId: made.id,
              details: { slug, administrator: email, ...by(operator) },
            });
            return administrator;
          },
        );
        return { tenant, administrator: result };
      },
    };
  }

  /** A first or extra administrator of an existing tenant. */
  async adminCreate(
    emailInput: string,
    options: { tenant: string; name?: string },
  ): Promise<
    Plan<{
      tenant: string;
      changed: boolean;
      created: boolean;
      password?: OneTimePassword;
    }>
  > {
    const email = this.email(emailInput);
    const tenant = await this.tenant(options.tenant);
    const summary = [
      `Make ${email} an administrator of "${tenant.slug}" (a new account gets a one-time password, shown once; an existing one keeps its password).`,
    ];
    if (!tenant.active) {
      summary.push(
        `Note: "${tenant.slug}" is deactivated: nobody can act in it until it is activated.`,
      );
    }
    return {
      summary,
      apply: (operator) =>
        this.system.run(
          OPS_JOB,
          async (system) => {
            const result = await this.makeAdministrator(email, options.name);
            if (result.changed) {
              await this.audit.record(system, {
                action: 'ops.admin-created',
                targetType: 'user',
                targetId: result.userId,
                details: { email, newAccount: result.created, ...by(operator) },
              });
            }
            return {
              tenant: tenant.slug,
              changed: result.changed,
              created: result.created,
              password: result.password,
            };
          },
          { tenantId: tenant.id },
        ),
    };
  }

  /** A one-time password for an account, and every session and token of it ended. */
  async resetPassword(emailInput: string): Promise<Plan<OneTimePassword>> {
    const email = this.email(emailInput);
    const user = await this.account(email);
    const summary = [
      `Set a new one-time password for ${email} (${user.name}), shown once.`,
      'Every session and token of the account is signed out.',
    ];
    if (!user.active) {
      summary.push('Note: the account is deactivated and stays so.');
    }
    return {
      summary,
      apply: async (operator) => {
        const password = oneTimePassword();
        const hash = await this.hasher.hash(password);
        const alert = await this.system.run(
          OPS_JOB,
          async (system) => {
            return this.accountOps.replacePassword(
              system,
              user.id,
              hash,
              by(operator),
            );
          },
          { tenantId: null },
        );
        // The package's stores, outside the transaction, as the API ends them.
        await this.sessions.revokeAll(user.id);
        await this.tokens.revokeAll(user.id);
        await this.accountOps.tell(alert);
        return { email, password };
      },
    };
  }

  /** Removes the authenticator and recovery codes, and ends the tokens that claim the second factor. */
  async removeMfa(emailInput: string): Promise<Plan<{ email: string }>> {
    const email = this.email(emailInput);
    const user = await this.account(email);
    return {
      summary: [
        `Remove the authenticator and the recovery codes of ${email}, and revoke its tokens.`,
        'Sessions stay: sign-in then asks for the password only.',
      ],
      apply: async (operator) => {
        const alert = await this.system.run(
          OPS_JOB,
          async (system) => {
            return this.accountOps.removeMfa(system, user.id, by(operator));
          },
          { tenantId: null },
        );
        await this.tokens.revokeAll(user.id);
        await this.accountOps.tell(alert);
        return { email };
      },
    };
  }

  /** Clears the failed second-factor attempts (the lockout) of an account. */
  async unlock(
    emailInput: string,
  ): Promise<Plan<{ email: string; failures: number }>> {
    const email = this.email(emailInput);
    const user = await this.account(email);
    const failures = await this.global(() =>
      this.accountOps.mfaFailures(user.id),
    );
    return {
      summary: [
        `Clear ${failures} failed second-factor attempt(s) of ${email} (the lockout).`,
        'Per-address rate limits (Redis) lapse by themselves within minutes.',
      ],
      apply: (operator) =>
        this.system.run(
          OPS_JOB,
          async (system) => {
            await this.accountOps.clearMfaFailures(user.id);
            await this.audit.record(system, {
              action: 'ops.user-unlocked',
              targetType: 'user',
              targetId: user.id,
              details: { email, failuresCleared: failures, ...by(operator) },
            });
            return { email, failures };
          },
          { tenantId: null },
        ),
    };
  }
}
