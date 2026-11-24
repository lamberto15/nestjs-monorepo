import { SessionService, TokenService } from '@nestjs/authentication';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import { and, asc, count, eq, inArray, type SQL, sql } from 'drizzle-orm';
import {
  patchBodyValidation,
  type ScimPatch,
  scimPatch,
  type ScimPatchOperation,
} from 'scim-patch';
import { z } from 'zod';
import type {
  Database,
  DatabaseTransactions,
} from '../../../core/database/database.js';
import { databaseErrorKind } from '../../../core/database/database-errors.js';
import { httpConfig } from '../../../core/http/http.config.js';
import { Tenancy } from '../../../core/tenancy/tenancy.service.js';
import {
  ACCESS_EVENTS,
  type MemberDeactivatedEvent,
  type MemberReactivatedEvent,
} from '../../access/access.events.js';
import { AccessService } from '../../access/access.service.js';
import { ScimMembers } from '../../access/scim-members.js';
import { RolesService } from '../../access/roles.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { memberships, users } from '../../auth/auth.tables.js';
import type { ClientPrincipal } from '../../auth/principal.js';
import { normalizeEmail } from '../../auth/users.repository.js';
import { emailDomain, SsoDomainsService } from '../sso-domains.service.js';
import { scimDeprovisionedUsers, scimUsers } from '../sso.tables.js';
import { SCIM_SCHEMA, ScimException } from './scim-error.filter.js';
import { scimFilter, scimPage } from './scim-filter.js';

/** Azure's `"True"`/`"False"` too: what a PATCH of `active` carries from some IdPs. */
const scimBoolean = z.preprocess(
  (value) =>
    typeof value === 'string' && /^(true|false)$/i.test(value)
      ? value.toLowerCase() === 'true'
      : value,
  z.boolean(),
);

/**
 * A SCIM User as an IdP writes it (RFC 7643 §4.1): `userName` required;
 * the core attributes this API reads checked, the rest (and the
 * enterprise extension) kept as sent, in `scim_users.attributes`.
 */
export const scimUserSchema = z.looseObject({
  schemas: z.array(z.string()).optional(),
  userName: z.string().trim().min(1).max(320),
  externalId: z.string().max(512).nullish(),
  active: scimBoolean.optional(),
  displayName: z.string().max(200).nullish(),
  name: z
    .looseObject({
      formatted: z.string().max(200).nullish(),
      givenName: z.string().max(200).nullish(),
      familyName: z.string().max(200).nullish(),
    })
    .nullish(),
  emails: z
    .array(
      z.looseObject({
        value: z.string().max(320),
        primary: scimBoolean.optional(),
        type: z.string().max(50).nullish(),
      }),
    )
    .max(20)
    .nullish(),
});
export type ScimUserInput = z.infer<typeof scimUserSchema>;

/** What is never stored: the server's own attributes, and those with a column. */
const NOT_STORED = new Set(['id', 'meta', 'schemas', 'active', 'externalId']);

interface Row {
  userId: string;
  externalId: string | null;
  attributes: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  active: boolean;
}

/**
 * SCIM 2.0 Users (RFC 7644) of the caller's tenant: the members its
 * identity provider provisions (README.md, "SCIM").
 *
 * - Create: an address of a domain the tenant verified only. The account
 *   with that address is linked (when its own address is proved: else
 *   whoever registered it first would join the tenant) or made (no
 *   password: it signs in through the tenant's SSO), and its membership
 *   made or reactivated.
 * - `active: false` or DELETE deprovisions: the membership is deactivated,
 *   that tenant's sessions and tokens stop acting in it, and what waits
 *   on the person moves on (`access.member-deactivated`), as an
 *   administrator's deactivation does. Its other tenants are untouched; when no active
 *   membership remains anywhere, the account is deactivated (never
 *   deleted), and provisioning or `active: true` brings it back.
 * - Only users the SCIM client provisioned (a `scim_users` row) are its:
 *   others' members are neither listed nor changed.
 * - SCIM never changes an account's address or name: they are the
 *   person's, across tenants. What the IdP sends is kept and answered.
 */
@Injectable()
@ScimMembers()
export class ScimUsersService implements ScimMembers {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly domains: SsoDomainsService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly roles: RolesService,
    private readonly events: EventEmitter2,
    private readonly tenancy: Tenancy,
    @Inject(httpConfig.KEY)
    private readonly http: ConfigType<typeof httpConfig>,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
  ) {}

  /** Those of these users the tenant's IdP provisioned: access lists them `managedByScim`. */
  async managedUserIds(userIds: readonly string[]) {
    const rows = await this.db
      .select({ id: scimUsers.userId })
      .from(scimUsers)
      .where(inArray(scimUsers.userId, [...userIds]));
    return new Set(rows.map((row) => row.id));
  }

  async list(query: { filter?: string; startIndex?: number; count?: number }) {
    const where = scimFilter(query.filter, {
      id: { column: scimUsers.userId, uuid: true },
      userName: {
        column: this.userNameColumn(),
        caseInsensitive: true,
      },
      externalId: { column: scimUsers.externalId },
      'emails.value': { column: users.email, caseInsensitive: true },
      active: { column: memberships.active },
    });
    const page = scimPage(query.startIndex, query.count);
    const [rows, [counted]] = await Promise.all([
      page.limit
        ? this.select(where)
            .orderBy(asc(scimUsers.createdAt), asc(scimUsers.userId))
            .limit(page.limit)
            .offset(page.offset)
        : Promise.resolve([]),
      this.db
        .select({ total: count() })
        .from(scimUsers)
        .innerJoin(users, eq(users.id, scimUsers.userId))
        .innerJoin(
          memberships,
          and(
            eq(memberships.tenantId, scimUsers.tenantId),
            eq(memberships.userId, scimUsers.userId),
          ),
        )
        .where(where),
    ]);
    return {
      schemas: [SCIM_SCHEMA.list],
      totalResults: counted?.total ?? 0,
      startIndex: page.startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((row) => this.resource(row)),
    };
  }

  async get(id: string) {
    return this.resource(await this.find(id));
  }

  async create(actor: ClientPrincipal, input: ScimUserInput, ip?: string) {
    const tenantId = this.tenancy.tenantId();
    const email = await this.verifiedEmailOf(input);
    let deactivated = false;
    let left = false;
    const userId = await this.unique(() =>
      this.txHost.withTransaction(async () => {
        if (input.externalId) {
          await this.assertExternalIdFree(input.externalId);
        }
        let [account] = await this.db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .for('update');
        let created = false;
        if (!account) {
          [account] = await this.db
            .insert(users)
            .values({
              email,
              name: displayNameOf(input, email),
              passwordHash: null,
              // The tenant proved it holds the domain (its DNS): its IdP's word counts.
              emailVerified: true,
            })
            .returning();
          created = true;
        } else {
          if (
            !account.active &&
            // Deactivated by deprovisioning: provisioning brings it back.
            !(await this.isDeprovisioned(account.id))
          ) {
            throw new ScimException(
              409,
              'The account with this address is deactivated.',
              'uniqueness',
            );
          }
          if (!account.emailVerified) {
            // Else whoever registered the address first, with a password
            // of their choosing, would become this tenant's member.
            throw new ScimException(
              409,
              'An account with this address exists and its address is unproved: it can’t be provisioned.',
              'uniqueness',
            );
          }
        }
        const member = await this.lockMembership(tenantId, account!.id);
        const [linked] = await this.db
          .select({ userId: scimUsers.userId })
          .from(scimUsers)
          .where(eq(scimUsers.userId, account!.id));
        if (linked) {
          throw new ScimException(
            409,
            'This user is already provisioned.',
            'uniqueness',
          );
        }
        if (!member) {
          await this.db
            .insert(memberships)
            .values({ tenantId, userId: account!.id });
        }
        await this.db.insert(scimUsers).values({
          userId: account!.id,
          externalId: input.externalId ?? null,
          attributes: attributesOf(input),
        });
        const wasActive = member ? member.active : true;
        const active = input.active ?? true;
        if (active !== wasActive) {
          await this.setActive(actor, tenantId, account!.id, active);
          left = !active;
        }
        deactivated = await this.settleAccount(actor, account!.id, active, ip);
        await this.audit.record(actor, {
          action: 'scim.user-provisioned',
          targetType: 'user',
          targetId: account!.id,
          details: {
            email,
            externalId: input.externalId ?? null,
            accountCreated: created,
            membershipCreated: !member,
            active,
          },
          ip,
        });
        return account!.id;
      }),
    );
    if (deactivated) await this.signOutEverywhere(userId);
    this.access.invalidate(tenantId);
    if (left) this.announceLeft(actor, tenantId, userId);
    return this.get(userId);
  }

  /** PUT: the IdP's whole representation replaces what was kept. */
  replace(
    actor: ClientPrincipal,
    id: string,
    input: ScimUserInput,
    ip?: string,
  ) {
    return this.write(actor, id, () => Promise.resolve(input), ip);
  }

  /**
   * Writes the representation `next` makes, under the account's and the
   * membership's locks: a PATCH reads the user it applies to only once it
   * holds them, so two at once never write back each other's stale copy
   * (a rename undoing a deactivation).
   */
  private async write(
    actor: ClientPrincipal,
    id: string,
    next: () => Promise<ScimUserInput>,
    ip?: string,
  ) {
    const tenantId = this.tenancy.tenantId();
    let deactivated = false;
    let left = false;
    await this.unique(() =>
      this.txHost.withTransaction(async () => {
        // The account's lock first, as a creation takes it: never the
        // other way round (a deadlock).
        await this.lockAccount(id);
        await this.lockMembership(tenantId, id);
        const input = await next();
        const before = await this.find(id);
        if (input.externalId && input.externalId !== before.externalId) {
          await this.assertExternalIdFree(input.externalId);
        }
        await this.db
          .update(scimUsers)
          .set({
            externalId: input.externalId ?? null,
            attributes: attributesOf(input),
            updatedAt: new Date(),
          })
          .where(eq(scimUsers.userId, id));
        const active = input.active ?? before.active;
        if (active !== before.active) {
          await this.setActive(actor, tenantId, id, active);
          left = !active;
          deactivated = await this.settleAccount(actor, id, active, ip);
        }
        await this.audit.record(actor, {
          action: 'scim.user-updated',
          targetType: 'user',
          targetId: id,
          details: {
            email: before.email,
            ...(active !== before.active && {
              active: { from: before.active, to: active },
            }),
            ...((input.externalId ?? null) !== before.externalId && {
              externalId: {
                from: before.externalId,
                to: input.externalId ?? null,
              },
            }),
          },
          ip,
        });
      }),
    );
    if (deactivated) await this.signOutEverywhere(id);
    this.access.invalidate(tenantId);
    if (left) this.announceLeft(actor, tenantId, id);
    return this.get(id);
  }

  /**
   * PATCH (RFC 7644 §3.5.2): the operations applied by scim-patch to the
   * user as answered, the result checked as a PUT's body and written as one.
   */
  async patch(actor: ClientPrincipal, id: string, body: unknown, ip?: string) {
    const operations = patchOperations(body);
    return this.write(actor, id, () => this.patched(id, operations), ip);
  }

  /** The user as it is now (read under write()'s locks), with `operations` applied. */
  private async patched(
    id: string,
    operations: ReturnType<typeof patchOperations>,
  ): Promise<ScimUserInput> {
    const current = await this.get(id);
    let patched: Record<string, unknown>;
    try {
      patched = scimPatch(
        current as unknown as Parameters<typeof scimPatch>[0],
        operations,
        { mutateDocument: false, treatMissingAsAdd: true },
      ) as unknown as Record<string, unknown>;
    } catch (error) {
      throw patchError(error);
    }
    const parsed = scimUserSchema.safeParse(patched);
    if (!parsed.success) {
      throw new ScimException(
        400,
        `The patched user is invalid: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        'invalidValue',
      );
    }
    if (
      normalizeEmail(parsed.data.userName) !==
        normalizeEmail(String(current.userName)) &&
      !(await this.isVerifiedAddress(parsed.data.userName))
    ) {
      throw new ScimException(
        400,
        'The userName isn’t an address of a domain the tenant verified.',
        'invalidValue',
      );
    }
    return parsed.data;
  }

  /**
   * DELETE: deprovisioned (the membership deactivated, as `active: false`),
   * and no longer the SCIM client's: a later POST of the same address
   * provisions it again.
   */
  async remove(actor: ClientPrincipal, id: string, ip?: string) {
    const tenantId = this.tenancy.tenantId();
    let deactivated = false;
    let left = false;
    await this.txHost.withTransaction(async () => {
      await this.lockAccount(id);
      await this.lockMembership(tenantId, id);
      const before = await this.find(id);
      if (before.active) {
        await this.setActive(actor, tenantId, id, false);
        left = true;
      }
      deactivated = await this.settleAccount(actor, id, false, ip);
      await this.db.delete(scimUsers).where(eq(scimUsers.userId, id));
      await this.audit.record(actor, {
        action: 'scim.user-deprovisioned',
        targetType: 'user',
        targetId: id,
        details: { email: before.email, externalId: before.externalId },
        ip,
      });
    });
    if (deactivated) await this.signOutEverywhere(id);
    this.access.invalidate(tenantId);
    if (left) this.announceLeft(actor, tenantId, id);
  }

  /** Those of `ids` the SCIM client provisioned: a group's members can only be these. */
  async provisioned(ids: string[]) {
    if (!ids.length) {
      return [];
    }
    const rows = await this.db
      .select({ id: scimUsers.userId })
      .from(scimUsers)
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, scimUsers.tenantId),
          eq(memberships.userId, scimUsers.userId),
        ),
      )
      .where(inArray(scimUsers.userId, [...new Set(ids)]));
    const known = new Set(rows.map((row) => row.id));
    return ids.filter((id) => known.has(id));
  }

  /** After the commit: the deactivation setActive() announced inside it (ACCESS_EVENTS). */
  private announceLeft(
    actor: ClientPrincipal,
    tenantId: string,
    userId: string,
  ) {
    this.events.emit(ACCESS_EVENTS.memberDeactivationCommitted, {
      userId,
      tenantId,
      actor,
    } satisfies MemberDeactivatedEvent);
  }

  /**
   * The membership turned on or off in the change's transaction, as an
   * administrator's deactivation (MembersService.update): at least one
   * administrator remains, and what waits on the person moves on
   * (`access.member-deactivated`, awaited: a listener's error rolls back).
   */
  private async setActive(
    actor: ClientPrincipal,
    tenantId: string,
    userId: string,
    active: boolean,
  ) {
    await this.db
      .update(memberships)
      .set({ active })
      .where(
        and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)),
      );
    if (!active) {
      await this.roles.assertAnAdministratorRemains();
      await this.events.emitAsync(ACCESS_EVENTS.memberDeactivated, {
        userId,
        tenantId,
        actor,
      } satisfies MemberDeactivatedEvent);
    }
  }

  /**
   * The account follows its memberships: deactivated, never deleted, when
   * deprovisioning leaves it no active membership in any tenant (its
   * sessions and tokens stop working: `users.active`); reactivated, the
   * same account with its data, when SCIM turns one on again. Audited in
   * the change's transaction. Returns whether it deactivated the account:
   * the caller then signs it out everywhere, once that is committed.
   */
  private async settleAccount(
    actor: ClientPrincipal,
    userId: string,
    active: boolean,
    ip?: string,
  ): Promise<boolean> {
    let changed = false;
    if (active) {
      const [marked] = await this.db
        .delete(scimDeprovisionedUsers)
        .where(eq(scimDeprovisionedUsers.userId, userId))
        .returning();
      if (marked) {
        await this.db
          .update(users)
          .set({ active: true })
          .where(eq(users.id, userId));
        changed = true;
      }
    } else {
      const [other] = await this.db
        .select({ tenantId: memberships.tenantId })
        .from(memberships)
        .where(
          and(eq(memberships.userId, userId), eq(memberships.active, true)),
        )
        .limit(1);
      if (!other) {
        const [deactivated] = await this.db
          .update(users)
          .set({ active: false })
          .where(and(eq(users.id, userId), eq(users.active, true)))
          .returning({ id: users.id });
        if (deactivated) {
          await this.db
            .insert(scimDeprovisionedUsers)
            .values({ userId })
            .onConflictDoNothing();
          changed = true;
        }
      }
    }
    if (changed) {
      await this.audit.record(actor, {
        action: active
          ? 'scim.account-reactivated'
          : 'scim.account-deactivated',
        targetType: 'user',
        targetId: userId,
        details: { reason: active ? 'membership' : 'no-active-membership' },
        ip,
      });
    }
    return changed && !active;
  }

  /**
   * A deactivated account's browser sessions and token families end (the
   * stores announce each, so its live sockets close too, modules/realtime),
   * as an erased account's do (iam/personal-data). `users.active` already
   * refuses them; this ends what is open.
   */
  private async signOutEverywhere(userId: string) {
    await this.sessions.revokeAll(userId);
    await this.tokens.revokeAll(userId);
  }

  /**
   * An administrator turned a membership back on (MembersService.update):
   * the account this module's deprovisioning deactivated, for want of an
   * active membership, comes back with it, the same account with its data.
   * Any other inactive account stays as it is. In the change's transaction
   * (a failure here rolls the reactivation back), audited
   * `user.account-reactivated`.
   */
  @OnEvent(ACCESS_EVENTS.memberReactivated, { suppressErrors: false })
  async membershipReactivated({ userId, actor, ip }: MemberReactivatedEvent) {
    const [marked] = await this.db
      .delete(scimDeprovisionedUsers)
      .where(eq(scimDeprovisionedUsers.userId, userId))
      .returning();
    if (!marked) {
      return;
    }
    await this.db
      .update(users)
      .set({ active: true })
      .where(eq(users.id, userId));
    await this.audit.record(actor, {
      action: 'user.account-reactivated',
      targetType: 'user',
      targetId: userId,
      details: { reason: 'membership' },
      ip,
    });
  }

  private async isDeprovisioned(userId: string) {
    const [row] = await this.db
      .select({ userId: scimDeprovisionedUsers.userId })
      .from(scimDeprovisionedUsers)
      .where(eq(scimDeprovisionedUsers.userId, userId));
    return !!row;
  }

  /** The account's row locked until the transaction ends (a creation takes it first too). */
  private async lockAccount(userId: string) {
    if (!z.uuid().safeParse(userId).success) {
      return;
    }
    await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
  }

  /** The membership, locked until the transaction ends; undefined without one. */
  private async lockMembership(tenantId: string, userId: string) {
    if (!z.uuid().safeParse(userId).success) {
      return undefined;
    }
    const [row] = await this.db
      .select({ active: memberships.active })
      .from(memberships)
      .where(
        and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)),
      )
      .for('update');
    return row;
  }

  private async verifiedEmailOf(input: ScimUserInput) {
    const candidates = [
      ...(input.emails ?? [])
        .slice()
        .sort((a, b) => Number(!!b.primary) - Number(!!a.primary))
        .map((email) => email.value),
      input.userName,
    ];
    const email = candidates.find(
      (value) => z.email().safeParse(value.trim()).success,
    );
    if (!email) {
      throw new ScimException(
        400,
        'The user needs an email address: in emails, or as its userName.',
        'invalidValue',
      );
    }
    if (!(await this.isVerifiedAddress(email))) {
      throw new ScimException(
        400,
        'The address isn’t in a domain the tenant verified.',
        'invalidValue',
      );
    }
    return normalizeEmail(email);
  }

  private async isVerifiedAddress(value: string) {
    return (
      z.email().safeParse(value.trim()).success &&
      this.domains.isVerified(emailDomain(normalizeEmail(value)))
    );
  }

  private async assertExternalIdFree(externalId: string) {
    const [taken] = await this.db
      .select({ userId: scimUsers.userId })
      .from(scimUsers)
      .where(eq(scimUsers.externalId, externalId));
    if (taken) {
      throw new ScimException(
        409,
        'Another user has this externalId.',
        'uniqueness',
      );
    }
  }

  /** Two creations at once: the second's unique violation is the 409 the first check gives. */
  private async unique<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (databaseErrorKind(error) === 'unique_violation') {
        throw new ScimException(
          409,
          'This user (or its externalId) is already provisioned.',
          'uniqueness',
        );
      }
      throw error;
    }
  }

  private userNameColumn() {
    // The userName the IdP sent, else the account's address.
    return sql`coalesce(${scimUsers.attributes}->>'userName', ${users.email})` as SQL;
  }

  private select(where?: SQL) {
    return this.db
      .select({
        userId: scimUsers.userId,
        externalId: scimUsers.externalId,
        attributes: scimUsers.attributes,
        createdAt: scimUsers.createdAt,
        updatedAt: scimUsers.updatedAt,
        email: users.email,
        active: memberships.active,
      })
      .from(scimUsers)
      .innerJoin(users, eq(users.id, scimUsers.userId))
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, scimUsers.tenantId),
          eq(memberships.userId, scimUsers.userId),
        ),
      )
      .where(where);
  }

  private async find(id: string): Promise<Row> {
    if (!z.uuid().safeParse(id).success) {
      throw new ScimException(404, `User ${id} not found.`);
    }
    const [row] = await this.db
      .select({
        userId: scimUsers.userId,
        externalId: scimUsers.externalId,
        attributes: scimUsers.attributes,
        createdAt: scimUsers.createdAt,
        updatedAt: scimUsers.updatedAt,
        email: users.email,
        active: memberships.active,
      })
      .from(scimUsers)
      .innerJoin(users, eq(users.id, scimUsers.userId))
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, scimUsers.tenantId),
          eq(memberships.userId, scimUsers.userId),
        ),
      )
      .where(eq(scimUsers.userId, id));
    if (!row) {
      throw new ScimException(404, `User ${id} not found.`);
    }
    return row;
  }

  /** The SCIM User answered: what the IdP sent, with the server's own attributes. */
  private resource(row: Row) {
    const base = this.http.appUrl;
    return {
      ...row.attributes,
      schemas: [
        SCIM_SCHEMA.user,
        ...(row.attributes[SCIM_SCHEMA.enterpriseUser]
          ? [SCIM_SCHEMA.enterpriseUser]
          : []),
      ],
      id: row.userId,
      ...(row.externalId !== null && { externalId: row.externalId }),
      userName: (row.attributes.userName as string | undefined) ?? row.email,
      active: row.active,
      meta: {
        resourceType: 'User',
        created: row.createdAt.toISOString(),
        lastModified: row.updatedAt.toISOString(),
        location: `${base}/v1/scim/Users/${row.userId}`,
      },
    };
  }
}

const attributesOf = (input: ScimUserInput) =>
  Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => !NOT_STORED.has(key) && value !== undefined,
    ),
  );

const displayNameOf = (input: ScimUserInput, email: string) => {
  const name =
    input.displayName?.trim() ||
    input.name?.formatted?.trim() ||
    [input.name?.givenName, input.name?.familyName]
      .filter(Boolean)
      .join(' ')
      .trim();
  return (name || email.split('@')[0] || email).slice(0, 200);
};

/** A PatchOp body's operations, checked by scim-patch. */
export function patchOperations(body: unknown): ScimPatchOperation[] {
  try {
    patchBodyValidation(body as ScimPatch);
  } catch (error) {
    throw patchError(error);
  }
  const operations = (body as ScimPatch).Operations;
  if (operations.length > 100) {
    throw new ScimException(400, 'At most 100 operations.', 'invalidValue');
  }
  return operations;
}

/** scim-patch's errors carry their `scimType`; anything else is a bad request. */
export function patchError(error: unknown) {
  const scimType = (error as { scimCode?: string }).scimCode;
  return new ScimException(
    400,
    (error as Error).message || 'The patch is invalid.',
    (scimType as ConstructorParameters<typeof ScimException>[2]) ??
      'invalidSyntax',
  );
}
