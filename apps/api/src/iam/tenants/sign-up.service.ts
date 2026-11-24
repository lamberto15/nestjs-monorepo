import { randomInt } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PasswordHasher } from '@nestjs/authentication';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { t } from '@nestjs/i18n';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { Events } from '../../core/outbox/events.js';
import { tenancyConfig } from '../../core/tenancy/tenancy.config.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { slugOf } from '../access/access.seeder.js';
import { PermissionCatalog } from '../access/permission-catalog.js';
import { AuditService } from '../audit/audit.service.js';
import { z } from 'zod';
import { AuthPolicy } from '../auth/auth-policy.js';
import type { users } from '../auth/auth.tables.js';
import {
  SignInMethodsPart,
  type SignInMethodsProvider,
} from '../auth/who-am-i.js';
import type { UserPrincipal } from '../auth/principal.js';
import { normalizeEmail } from '../auth/users.repository.js';
import { tenantCreated } from './tenants.events.js';
import { tenantsConfig } from './tenants.config.js';
import { TenantsRepository } from './tenants.repository.js';
import { TenantsService } from './tenants.service.js';

/** What a sign-up asks for. */
export interface SignUpInput {
  email: string;
  name: string;
  password: string;
  locale: string | null;
  timezone: string | null;
  /** TENANT_SIGN_UP: the new tenant's name (the person's name without one). */
  tenantName?: string;
}

/**
 * Fired after a sign-up committed: the account module mails the
 * verification link (it listens by this name: iam/account's
 * sign-up-mail.listener.ts).
 */
export const SIGN_UP_EVENTS = { signedUp: 'tenancy.user-signed-up' } as const;

export interface UserSignedUpEvent {
  user: UserPrincipal;
}

/** The random part of a sign-up tenant's slug: 36^6 handles per name. */
const SUFFIX = 6;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** A drawn slug taken already (one in 10⁹): drawn again, this many times in all. */
const ATTEMPTS = 3;

/**
 * Self sign-up (AUTH_SIGN_UP): a new account with a password, unverified,
 * which signs in only once its address is proved (verify first). Where it
 * lands depends on the deployment:
 *
 * - TENANCY=single: it joins the one tenant with SIGN_UP_ROLES, audited
 *   `user.joined`;
 * - TENANT_SIGN_UP=on (TENANCY=multi): it makes its own tenant (named
 *   `tenantName`, its slug drawn, never chosen, so a sign-up can't probe
 *   or squat handles) and is its first administrator, audited
 *   `tenant.created` in it; the tenant is marked for the unverified
 *   sign-ups' sweep;
 * - otherwise: in no tenant, until an invitation.
 *
 * An account refused (its address taken) leaves no tenant behind.
 */
@Injectable()
@SignInMethodsPart({
  signUp: z.boolean().describe('Self sign-up (`POST /v1/auth/sign-up`).'),
  tenantSignUp: z
    .boolean()
    .describe('A sign-up makes its own tenant (asks for `tenantName`).'),
})
export class SignUpService
  implements OnApplicationBootstrap, SignInMethodsProvider
{
  private readonly logger = new Logger(SignUpService.name);

  constructor(
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly tenants: TenantsService,
    private readonly repository: TenantsRepository,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasher,
    private readonly catalog: PermissionCatalog,
    private readonly emitter: EventEmitter2,
    private readonly events: Events,
    private readonly authPolicy: AuthPolicy,
    @Inject(tenantsConfig.KEY)
    private readonly config: ConfigType<typeof tenantsConfig>,
    @Inject(tenancyConfig.KEY)
    private readonly tenancyMode: ConfigType<typeof tenancyConfig>,
  ) {}

  private get single() {
    return this.tenancyMode.mode === 'single';
  }

  /** Whether a sign-up makes its own tenant here. */
  get makesTenants() {
    return this.config.signUp && this.config.tenantSignUp && !this.single;
  }

  /** What `GET /v1/auth/methods` says of sign-up. */
  signInMethods() {
    return { signUp: this.config.signUp, tenantSignUp: this.makesTenants };
  }

  /**
   * The switches checked at start: what they can't do is said, never
   * silent; SIGN_UP_ROLES names declared seed roles only (never the
   * built-in Administrator: an open sign-up must not hand out the tenant).
   */
  onApplicationBootstrap() {
    const { tenantSignUp, signUp, signUpRoles } = this.config;
    if (tenantSignUp && this.single) {
      this.logger.warn(
        'TENANT_SIGN_UP is ignored with TENANCY=single: sign-ups join the one tenant.',
      );
    } else if (tenantSignUp && !signUp) {
      this.logger.warn(
        'TENANT_SIGN_UP is ignored with AUTH_SIGN_UP=off: nobody signs up.',
      );
    }
    if (!this.single) {
      if (signUpRoles.length) {
        this.logger.warn(
          'SIGN_UP_ROLES is ignored with TENANCY=multi: sign-ups join no tenant.',
        );
      }
      return;
    }
    const declared = new Set(this.catalog.seedRoles.map((role) => role.key));
    const unknown = signUpRoles.filter((key) => !declared.has(key));
    if (unknown.length) {
      throw new Error(
        `SIGN_UP_ROLES names roles no declaration seeds: ${unknown.join(', ')} (known: ${[...declared].join(', ') || 'none'}).`,
      );
    }
  }

  async signUp(input: SignUpInput, ip?: string): Promise<UserPrincipal> {
    if (!this.config.signUp) {
      throw new ForbiddenException({
        code: 'sign_up_closed',
        message: t('tenants.signUpClosed'),
      });
    }
    // TENANCY=single: the one tenant's minimum length; elsewhere none yet.
    await this.authPolicy.assertPasswordLength(input.password, 'password', {
      tenantIds: this.single ? [(await this.tenancy.soleTenant()).id] : [],
    });
    const passwordHash = await this.hasher.hash(input.password);
    const values = {
      email: normalizeEmail(input.email),
      name: input.name,
      locale: input.locale,
      timezone: input.timezone,
      passwordHash,
    };
    const user = await this.place(
      values,
      input.tenantName ?? input.name,
      ip,
    ).catch((error: unknown) => {
      throw databaseErrorKind(error) === 'unique_violation' &&
        !isSlugTaken(error)
        ? new ConflictException({
            code: 'email_taken',
            message: t('tenants.emailTaken'),
          })
        : error;
    });
    await this.emitter.emitAsync(SIGN_UP_EVENTS.signedUp, {
      user,
    } satisfies UserSignedUpEvent);
    return user;
  }

  /** The account, made where the deployment puts sign-ups, in one transaction with its entries. */
  private async place(
    values: typeof users.$inferInsert,
    tenantName: string,
    ip?: string,
  ): Promise<UserPrincipal> {
    if (this.single) {
      const { id: tenantId } = await this.tenancy.soleTenant();
      return this.tenancy.run(tenantId, () =>
        this.txHost.withTransaction(async () => {
          const user = await this.insert(values, ip);
          await this.joinSoleTenant(user, ip);
          return { ...user, tenantId };
        }),
      );
    }
    if (!this.makesTenants) {
      return this.tenancy.run(null, () =>
        this.txHost.withTransaction(() => this.insert(values, ip)),
      );
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const { result } = await this.tenants.makeTenant(
          { name: tenantName, slug: drawSlug(tenantName) },
          async (tenant) => {
            const user = await this.insert(values, ip);
            await this.tenants.addAdministrator(user.id);
            await this.audit.record(
              { ...user, tenantId: tenant.id },
              {
                action: 'tenant.created',
                targetType: 'tenant',
                targetId: tenant.id,
                details: { slug: tenant.slug, via: 'sign-up' },
                ip,
              },
            );
            await this.events.publish(
              tenantCreated,
              { tenantId: tenant.id, slug: tenant.slug, via: 'sign-up' },
              { key: tenant.id },
            );
            return user;
          },
          { createdBySignUp: true },
        );
        return result;
      } catch (error) {
        if (attempt < ATTEMPTS && isSlugTaken(error)) {
          continue;
        }
        throw error;
      }
    }
  }

  /** The account row and its `user.signed-up` entry, in the current scope. */
  private async insert(
    values: typeof users.$inferInsert,
    ip?: string,
  ): Promise<UserPrincipal> {
    const row = await this.repository.insertUser({
      ...values,
      emailVerified: false,
    });
    const user: UserPrincipal = {
      kind: 'user',
      id: row.id,
      email: row.email,
      name: row.name,
      emailVerified: false,
      locale: row.locale,
      timezone: row.timezone,
      tenantId: null,
    };
    await this.audit.record(user, {
      action: 'user.signed-up',
      targetType: 'user',
      targetId: user.id,
      ip,
    });
    return user;
  }

  /** TENANCY=single: the account joins the tenant with SIGN_UP_ROLES. */
  private async joinSoleTenant(user: UserPrincipal, ip?: string) {
    const tenantId = this.tenancy.tenantId();
    await this.repository.insertMembership(user.id);
    const granted = this.config.signUpRoles.length
      ? await this.repository.roleIdsByKeys(this.config.signUpRoles)
      : [];
    if (granted.length) {
      await this.repository.insertGrants(user.id, granted);
    }
    await this.audit.record(
      { ...user, tenantId },
      {
        action: 'user.joined',
        targetType: 'user',
        targetId: user.id,
        details: { via: 'sign-up', roleIds: granted },
        ip,
      },
    );
  }
}

/** `acme-corp-k3x9q2`: the name's slug (shortened to fit 48) and a random suffix. */
export function drawSlug(name: string): string {
  const base = slugOf(name)
    .slice(0, 48 - SUFFIX - 1)
    .replace(/-+$/, '');
  let suffix = '';
  for (let i = 0; i < SUFFIX; i++) {
    suffix += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${base || 'tenant'}-${suffix}`;
}

function isSlugTaken(error: unknown): boolean {
  if (!(error instanceof ConflictException)) {
    return false;
  }
  const body = error.getResponse();
  return (body as { code?: unknown } | null)?.code === 'tenant_slug_taken';
}
