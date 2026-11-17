import { createHash, randomBytes } from 'node:crypto';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PasswordHasher } from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { httpConfig } from '../../core/http/http.config.js';
import { MailQueue } from '../../core/mail/mail.queue.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { BreachedPasswordsService } from '../account/breached-passwords.service.js';
import { AccessService } from '../access/access.service.js';
import { regrant } from '../access/members.service.js';
import { roles, userRoles } from '../access/access.tables.js';
import { RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import { memberships, users } from '../auth/auth.tables.js';
import {
  actorOf,
  principalKey,
  type Principal,
  type UserPrincipal,
} from '../auth/principal.js';
import { normalizeEmail } from '../auth/users.repository.js';
import { InvitationUnits } from './invitation-units.js';
import { invitationsConfig } from './invitations.config.js';
import { TenantInvitationMail } from './invitations.mail.js';
import { invitations } from './invitations.tables.js';

/** What an invitation grants once accepted. */
export interface InvitationInput {
  /** Needed to send; a prepared one may wait for it. */
  email?: string;
  /** The name a new account starts with. */
  name?: string;
  roleIds: string[];
  roleExpiresAt?: Record<string, string>;
  unitIds?: string[];
}

/** What an administrator changes of a pending invitation; `email: null` takes the address away. */
export interface InvitationChanges {
  email?: string | null;
  name?: string | null;
  roleIds?: string[];
  roleExpiresAt?: Record<string, string>;
  unitIds?: string[];
}

type Invitation = typeof invitations.$inferSelect;

/** `inv_<tenant id>_<secret>`: the tenant, so the invitation is read in its scope. */
const TOKEN =
  /^inv_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;

const hashOf = (token: string) =>
  createHash('sha256').update(token).digest('base64url');

/** A pending invitation's state, from its link: none yet, running, or ended. */
export const invitationStatus = (sent: boolean, expiresAt: Date | null) =>
  !sent
    ? ('prepared' as const)
    : expiresAt && expiresAt.getTime() > Date.now()
      ? ('sent' as const)
      : ('expired' as const);

/** An invitation as the routes that add, change or send one answer. */
const view = (invitation: Invitation) => ({
  id: invitation.id,
  email: invitation.email,
  status: invitationStatus(invitation.tokenHash !== null, invitation.expiresAt),
  expiresAt: invitation.expiresAt,
});

/**
 * Adding people to a tenant, the one pending-member lifecycle. An
 * administrator invites an address (sent now) or prepares a member (sent
 * later) with the roles and units its membership will have; sending gives
 * the address a link. Nothing about an account is read, changed or shown
 * until its owner accepts, and the answer is the same whether or not the
 * address has an account: a new address chooses its password with the link
 * (which proves the mailbox), an existing account accepts while signed in.
 * Administrators never set or change anyone's password: a tenant can't take
 * over an account another tenant's members use, nor learn which addresses
 * have one.
 *
 * The link's token is 256 random bits, only its SHA-256 is stored, it works
 * once and until `expiresAt`; sending again makes a new one and the old one
 * stops.
 */
@Injectable()
export class InvitationsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly roles: RolesService,
    private readonly units: InvitationUnits,
    private readonly mailQueue: MailQueue,
    private readonly passwordHasher: PasswordHasher,
    private readonly moduleRef: ModuleRef,
    @Inject(invitationsConfig.KEY)
    private readonly config: ConfigType<typeof invitationsConfig>,
    @Inject(httpConfig.KEY)
    private readonly http: ConfigType<typeof httpConfig>,
  ) {}

  /**
   * Invites or prepares a member (`send`: the link is mailed now). The
   * actor must be able to grant the roles and place people in the units.
   */
  async invite(
    actor: UserPrincipal,
    input: InvitationInput & { send: boolean },
    ip?: string,
  ) {
    await this.roles.checkRoleGrant(actor, input.roleIds);
    await this.assertUnits(actor, input.unitIds ?? []);
    regrant(new Map(), input.roleIds, input.roleExpiresAt);
    const { invitation, token } = await this.txHost.withTransaction(
      async () => {
        const created = await this.create(input, actor, input.send);
        await this.audit.record(actor, {
          action: input.send ? 'user.invited' : 'invitation.prepared',
          targetType: 'invitation',
          targetId: created.invitation.id,
          details: {
            email: created.invitation.email,
            roleIds: created.invitation.roleIds,
            unitIds: created.invitation.unitIds,
            ...(input.roleExpiresAt && { roleExpiresAt: input.roleExpiresAt }),
          },
          ip,
        });
        return created;
      },
    );
    if (token) await this.deliver(invitation, token, actor);
    return view(invitation);
  }

  /**
   * An invitation to the current tenant, in the caller's transaction (which
   * records its audit entry): a pending one to the same address is replaced.
   * `send`: with its link, whose token is returned (`deliver()` mails it
   * after the commit); otherwise prepared, with no link (token null). Also
   * what making a tenant uses for its first administrator.
   */
  async create(input: InvitationInput, inviter: Principal, send = true) {
    const email = input.email ? normalizeEmail(input.email) : null;
    if (send && !email) throw emailRequired();
    const link = send ? this.newLink() : null;
    if (email) await this.replacePendingTo(email);
    const [invitation] = await this.db
      .insert(invitations)
      .values({
        email,
        name: input.name ?? null,
        roleIds: [...new Set(input.roleIds)],
        roleExpiresAt: input.roleExpiresAt ?? {},
        unitIds: [...new Set(input.unitIds ?? [])],
        invitedBy: principalKey(inviter),
        ...(link && {
          tokenHash: link.tokenHash,
          expiresAt: link.expiresAt,
          sentAt: new Date(),
        }),
      })
      .returning();
    return { invitation: invitation!, token: link?.token ?? null };
  }

  /**
   * Changes a pending invitation (prepared or sent); only what is sent
   * changes. Who changes it must be able to hand out what it carries and
   * what it will: otherwise moving its address would hand another
   * administrator's roles to any mailbox. A new address withdraws the link
   * (prepared again, send it again). Under the invitation's lock: an
   * acceptance or another change waits, or ran first (404 once accepted).
   */
  async update(
    actor: UserPrincipal,
    id: string,
    changes: InvitationChanges,
    ip?: string,
  ) {
    const updated = await this.txHost.withTransaction(async () => {
      const current = await this.lockPending(id);
      await this.assertAuthorityOver(actor, current);
      const roleIds = changes.roleIds ?? current.roleIds;
      if (changes.roleIds) await this.roles.checkRoleGrant(actor, roleIds);
      if (changes.unitIds) await this.assertUnits(actor, changes.unitIds);
      // The ends of roles taken away go with them; one passed meanwhile is gone.
      const roleExpiresAt =
        changes.roleExpiresAt ??
        Object.fromEntries(
          Object.entries(current.roleExpiresAt).filter(
            ([roleId, end]) =>
              roleIds.includes(roleId) && Date.parse(end) > Date.now(),
          ),
        );
      regrant(new Map(), roleIds, roleExpiresAt);
      const email =
        changes.email === undefined
          ? current.email
          : changes.email && normalizeEmail(changes.email);
      const moved = email !== current.email;
      if (moved && email) await this.replacePendingTo(email, current.id);
      const [invitation] = await this.db
        .update(invitations)
        .set({
          email,
          ...(changes.name !== undefined && { name: changes.name }),
          ...(changes.roleIds && { roleIds: [...new Set(roleIds)] }),
          roleExpiresAt,
          ...(changes.unitIds && { unitIds: [...new Set(changes.unitIds)] }),
          ...(moved && { tokenHash: null, expiresAt: null, sentAt: null }),
        })
        .where(eq(invitations.id, id))
        .returning();
      await this.audit.record(actor, {
        action: 'invitation.updated',
        targetType: 'invitation',
        targetId: id,
        details: {
          email: invitation!.email,
          ...(moved && { emailFrom: current.email }),
          ...(changes.roleIds && {
            roleIds: { from: current.roleIds, to: invitation!.roleIds },
          }),
          ...(changes.roleExpiresAt && {
            roleExpiresAt: invitation!.roleExpiresAt,
          }),
          ...(changes.unitIds && {
            unitIds: { from: current.unitIds, to: invitation!.unitIds },
          }),
          ...(moved && current.tokenHash !== null && { linkWithdrawn: true }),
        },
        ip,
      });
      return invitation!;
    });
    return view(updated);
  }

  /**
   * Sends a pending invitation: a prepared one its first link, a sent one
   * (expired or not) a new link (the old one stops working: only its hash
   * was kept) and expiry, with the same roles, their ends and units.
   * Sending hands out the roles, so the rules are checked again, as when
   * inviting. 400 `email_required` without an address.
   */
  async send(actor: UserPrincipal, id: string, ip?: string) {
    const { invitation, token } = await this.txHost.withTransaction(
      async () => {
        const current = await this.lockPending(id);
        if (!current.email) throw emailRequired();
        await this.assertAuthorityOver(actor, current);
        const link = this.newLink();
        const [renewed] = await this.db
          .update(invitations)
          .set({
            tokenHash: link.tokenHash,
            expiresAt: link.expiresAt,
            sentAt: new Date(),
          })
          .where(eq(invitations.id, id))
          .returning();
        await this.audit.record(actor, {
          action: current.tokenHash ? 'invitation.resent' : 'invitation.sent',
          targetType: 'invitation',
          targetId: id,
          details: {
            email: renewed!.email,
            roleIds: renewed!.roleIds,
            unitIds: renewed!.unitIds,
          },
          ip,
        });
        return { invitation: renewed!, token: link.token };
      },
    );
    await this.deliver(invitation, token, actor);
    return view(invitation);
  }

  /** Mails the link (after the invitation's commit), in the inviter's language. */
  async deliver(
    invitation: Pick<Invitation, 'email' | 'expiresAt'>,
    token: string,
    inviter: Principal,
  ) {
    const tenant = await this.tenancy.find(this.tenancy.tenantId());
    const base = this.config.webUrl ?? this.http.appUrl;
    await this.mailQueue.send(TenantInvitationMail, {
      to: invitation.email!,
      locale: (inviter.kind === 'user' && inviter.locale) || undefined,
      data: {
        inviter: actorOf(inviter).actorLabel,
        tenant: tenant!.name,
        url: `${base}/accept-invitation?token=${encodeURIComponent(token)}`,
        expiresAt: invitation.expiresAt!,
      },
    });
  }

  /**
   * The tenant's invitations not accepted yet, newest first, each with its
   * `status`: `prepared` (no link yet), `sent`, or `expired` (its link).
   */
  async pending() {
    const rows = await this.db
      .select({
        id: invitations.id,
        email: invitations.email,
        name: invitations.name,
        roleIds: invitations.roleIds,
        roleExpiresAt: invitations.roleExpiresAt,
        unitIds: invitations.unitIds,
        invitedBy: invitations.invitedBy,
        tokenHash: invitations.tokenHash,
        sentAt: invitations.sentAt,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(isNull(invitations.acceptedAt))
      .orderBy(desc(invitations.id));
    return rows.map(({ tokenHash, ...row }) => ({
      ...row,
      status: invitationStatus(tokenHash !== null, row.expiresAt),
    }));
  }

  /** Withdraws a pending invitation: its link stops working. */
  async revoke(actor: UserPrincipal, id: string, ip?: string) {
    await this.txHost.withTransaction(async () => {
      const [gone] = await this.db
        .delete(invitations)
        .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt)))
        .returning({
          email: invitations.email,
          roleIds: invitations.roleIds,
        });
      if (!gone) throw notFound(id);
      await this.audit.record(actor, {
        action: 'invitation.revoked',
        targetType: 'invitation',
        targetId: id,
        details: { email: gone.email, roleIds: gone.roleIds },
        ip,
      });
    });
  }

  /**
   * Accepts an invitation with its link's token. A new address makes its
   * account here (`password`, `name`), its address proved by the link; an
   * existing account must be the caller's (signed in as it). The membership
   * gets the invitation's roles and units, in the invitation's tenant, in
   * one transaction under the account's and the membership's locks (a
   * deactivation racing it waits, or wins first and the acceptance is
   * refused: an acceptance never turns a deactivated membership back on,
   * an administrator does). Every refusal of the link is the same 400
   * `invitation_invalid`.
   */
  async accept(
    token: string,
    input: { password?: string; name?: string },
    caller: UserPrincipal | null,
    ip: string,
  ) {
    const tenantId = TOKEN.exec(token)?.[1];
    if (!tenantId) throw invalid();
    const tenant = await this.tenancy.find(tenantId);
    if (!tenant?.active) throw invalid();
    return this.tenancy.run(tenantId, () =>
      this.acceptIn(tenantId, token, input, caller, ip),
    );
  }

  private async acceptIn(
    tenantId: string,
    token: string,
    input: { password?: string; name?: string },
    caller: UserPrincipal | null,
    ip: string,
  ) {
    const [invitation] = await this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, hashOf(token)),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      );
    // A prepared one has no token (nor address): nothing matches it.
    if (!invitation?.email) throw invalid();
    const email = invitation.email;
    const [account] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email));
    if (account && !account.active) throw invalid();
    let passwordHash: string | undefined;
    if (!account) {
      if (!input.password) {
        // A new address: its owner chooses the password here.
        throw new BadRequestException({
          code: 'password_required',
          message: t('invitations.required'),
          errors: [{ path: 'password', message: t('invitations.required') }],
        });
      }
      await this.moduleRef
        .get(BreachedPasswordsService, { strict: false })
        .assertNotBreached(input.password, 'password');
      passwordHash = await this.passwordHasher.hash(input.password);
    } else {
      if (!caller) {
        throw new UnauthorizedException({
          code: 'sign_in_required',
          message: t('invitations.signIn'),
        });
      }
      if (caller.id !== account.id) {
        throw new ForbiddenException({
          code: 'invitation_other_account',
          message: t('invitations.otherAccount'),
        });
      }
      if (caller.impersonator) {
        throw new ForbiddenException(t('invitations.notWhileImpersonating'));
      }
    }
    const user = await this.txHost.withTransaction(async () => {
      const row =
        account ??
        (await this.db
          .insert(users)
          .values({
            email,
            name: input.name ?? invitation.name ?? email,
            passwordHash: passwordHash!,
            // The link reached this mailbox: the address is proved.
            emailVerified: true,
          })
          .returning()
          .catch((error: unknown) => {
            // The address got an account meanwhile: start again, signed in.
            throw databaseErrorKind(error) === 'unique_violation'
              ? invalid()
              : error;
          })
          .then(([created]) => created!));
      // Under the account's lock (its deletion can't slip in between) and
      // the membership's (a deactivation neither).
      const [locked] = await this.db
        .select({ active: users.active })
        .from(users)
        .where(eq(users.id, row.id))
        .for('update');
      if (!locked?.active) throw invalid();
      const [membership] = await this.db
        .select({ active: memberships.active })
        .from(memberships)
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.userId, row.id),
          ),
        )
        .for('update');
      if (membership && !membership.active) {
        throw new ForbiddenException({
          code: 'membership_inactive',
          message: t('invitations.membershipInactive'),
        });
      }
      // Taken once, with this link and its address still current: a second
      // accept of the same link, or one an administrator's change withdrew
      // meanwhile (a new address), finds nothing. What is granted is what
      // the invitation holds now.
      const [taken] = await this.db
        .update(invitations)
        .set({ acceptedAt: new Date(), acceptedBy: row.id })
        .where(
          and(
            eq(invitations.id, invitation.id),
            isNull(invitations.acceptedAt),
            eq(invitations.tokenHash, hashOf(token)),
            eq(invitations.email, email),
          ),
        )
        .returning();
      if (!taken) throw invalid();
      if (!membership) {
        await this.db.insert(memberships).values({ tenantId, userId: row.id });
      }
      if (!row.emailVerified) {
        await this.db
          .update(users)
          .set({ emailVerified: true })
          .where(eq(users.id, row.id));
      }
      await this.grant(row.id, taken);
      await this.audit.record(
        {
          kind: 'user',
          id: row.id,
          email: row.email,
          name: row.name,
          emailVerified: true,
          locale: row.locale,
          timezone: row.timezone,
          tenantId,
        },
        {
          action: 'user.joined',
          targetType: 'user',
          targetId: row.id,
          details: {
            invitation: invitation.id,
            invitedBy: taken.invitedBy,
            roleIds: taken.roleIds,
            ...(account ? {} : { accountCreated: true }),
          },
          ip,
        },
      );
      return row;
    });
    this.access.invalidate();
    return { tenantId, userId: user.id, accountCreated: !account };
  }

  /**
   * The invitation's roles and units, as they are now: a role or unit
   * deleted since is left out (row-level security keeps it to the tenant).
   */
  private async grant(userId: string, invitation: Invitation) {
    await this.db.delete(userRoles).where(eq(userRoles.userId, userId));
    const existing = invitation.roleIds.length
      ? await this.db
          .select({ id: roles.id })
          .from(roles)
          .where(inArray(roles.id, invitation.roleIds))
      : [];
    const now = Date.now();
    const grants = existing
      .map(({ id }) => {
        const end = invitation.roleExpiresAt[id];
        return { roleId: id, expiresAt: end ? new Date(end) : null };
      })
      .filter(({ expiresAt }) => !expiresAt || expiresAt.getTime() > now);
    if (grants.length) {
      await this.db
        .insert(userRoles)
        .values(grants.map((grant) => ({ userId, ...grant })));
    }
    await this.units.place(userId, invitation.unitIds);
  }

  /** The unit ids exist, and the actor may place people in them. */
  private async assertUnits(actor: UserPrincipal, unitIds: string[]) {
    await this.units.assertExist(unitIds);
    await this.units.assertAuthority(actor, unitIds);
  }

  /**
   * The actor may hand out what a pending invitation carries, as when
   * inviting: grant its roles and place people in its units (those still
   * there; deleted ones are left out, as the acceptance does).
   */
  private async assertAuthorityOver(actor: UserPrincipal, current: Invitation) {
    const existing = current.roleIds.length
      ? await this.db
          .select({ id: roles.id })
          .from(roles)
          .where(inArray(roles.id, current.roleIds))
      : [];
    await this.roles.checkRoleGrant(
      actor,
      existing.map((role) => role.id),
    );
    await this.units.assertAuthority(
      actor,
      await this.units.existing(current.unitIds),
    );
  }

  /** A pending invitation, locked until the transaction ends (one change at a time); 404 otherwise. */
  private async lockPending(id: string) {
    const [invitation] = await this.db
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt)))
      .for('update');
    if (!invitation) throw notFound(id);
    return invitation;
  }

  /** One pending invitation per address: the newest replaces the others. */
  private async replacePendingTo(email: string, keep?: string) {
    await this.db
      .delete(invitations)
      .where(
        and(
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          keep ? ne(invitations.id, keep) : undefined,
          isNotNull(invitations.email),
        ),
      );
  }

  /** A link's token (`inv_<tenant>_<secret>`), its stored hash, and when it ends. */
  private newLink() {
    const token = `inv_${this.tenancy.tenantId()}_${randomBytes(32).toString('base64url')}`;
    return {
      token,
      tokenHash: hashOf(token),
      expiresAt: new Date(Date.now() + this.config.ttlHours * 3_600_000),
    };
  }
}

const notFound = (id: string) =>
  new NotFoundException(`Invitation ${id} not found.`);

const emailRequired = () =>
  new BadRequestException({
    code: 'email_required',
    message: 'Give the invitation an address before sending it.',
    errors: [{ path: 'email', message: t('invitations.required') }],
  });

const invalid = () =>
  new BadRequestException({
    code: 'invitation_invalid',
    message: t('invitations.invalid'),
  });
