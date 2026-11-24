import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { SessionService, SignInService } from '@nestjs/authentication';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Propagation, TransactionHost } from '@nestjs-cls/transactional';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { AccessService } from '../access/access.service.js';
import { RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AUTH_EVENTS, type SignedInEvent } from '../auth/auth.events.js';
import type { users } from '../auth/auth.tables.js';
import {
  authenticationOf,
  methodMetadata,
} from '../auth/authentication-method.js';
import { DrizzleAuthenticationStore } from '../auth/drizzle-authentication.store.js';
import type { UserPrincipal } from '../auth/principal.js';
import { normalizeEmail, UsersRepository } from '../auth/users.repository.js';
import { SsoAccountsRepository } from './sso-accounts.repository.js';
import { SsoConnectionsRepository } from './sso-connections.repository.js';
import type { SsoConnection } from './sso-connections.service.js';
import { emailDomain, SsoDomainsService } from './sso-domains.service.js';
import { SsoRefused } from './sso-refused.js';

/** Who the IdP says signed in: from a verified ID token, a verified assertion, or an OAuth 2.0 provider's user-info answer. */
export interface SsoIdentity {
  /** The IdP's immutable subject (`sub`, the persistent NameID). */
  subject: string;
  email?: string;
  /**
   * The IdP asserted the address belongs to the person: OIDC's
   * `email_verified`; an OAuth 2.0 connection's mapping (a field that must
   * be true, or `verified-domains`); SAML has no such claim, and the
   * tenant's verified domain is what makes its word count.
   */
  emailVerified: boolean;
  name?: string;
  /** When the IdP authenticated the person, when it says (`auth_time`, `AuthnInstant`). */
  authenticatedAt?: Date;
  /** The groups the IdP lists (the connection's `groupsAttribute`), for its role mappings. */
  groups?: string[];
}

export { SsoRefused };

/** The sign-in method of a connection: `sso:<connection id>` (the session's provider). */
export const ssoProvider = (connectionId: string) => `sso:${connectionId}`;

/**
 * The account an SSO identity signs in to, in the connection's tenant
 * (README.md, "No account takeover"):
 *
 * - a known identity (the connection + subject): its account, while it
 *   is active, and its membership, unless deactivated (deprovisioned);
 * - else only an address of a domain the tenant verified, and, for OIDC
 *   and OAuth 2.0, one the IdP says is verified;
 * - an existing account with that address is linked only when its own
 *   address is proved (else someone who registered it first, with a
 *   password of their choosing, would get the person's sign-ins);
 * - no membership yet: one is made only with just-in-time provisioning on
 *   (and the account too, when the address has none).
 *
 * Then the roles the connection maps the IdP's groups to (`syncRoles()`),
 * and the session (`method: sso`, `provider: <connection id>`, in the
 * connection's tenant), audited and alerted as any sign-in.
 */
@Injectable()
export class SsoAccounts {
  private readonly logger = new Logger(SsoAccounts.name);

  constructor(
    private readonly repository: SsoAccountsRepository,
    private readonly connections: SsoConnectionsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly users: UsersRepository,
    private readonly domains: SsoDomainsService,
    private readonly audit: AuditService,
    private readonly signInService: SignInService,
    private readonly sessions: SessionService,
    private readonly store: DrizzleAuthenticationStore,
    private readonly roles: RolesService,
    private readonly access: AccessService,
    private readonly events: EventEmitter2,
  ) {}

  /** The account to sign in, or SsoRefused. Runs in the connection's tenant. */
  async resolve(connection: SsoConnection, identity: SsoIdentity) {
    const { userId, rolesChanged } = await this.resolveInTransaction(
      connection,
      identity,
    );
    if (rolesChanged) {
      this.access.invalidate(connection.tenantId);
    }
    return userId;
  }

  private async resolveInTransaction(
    connection: SsoConnection,
    identity: SsoIdentity,
  ) {
    const tenantId = connection.tenantId;
    return this.txHost.withTransaction(async () => {
      const known = await this.repository.findIdentity(
        connection.id,
        identity.subject,
      );
      if (known) {
        if (!known.active) {
          throw new SsoRefused('account_inactive');
        }
        const provisioned = await this.ensureMember(
          connection,
          known.userId,
          identity,
        );
        return {
          userId: known.userId,
          rolesChanged: await this.syncRoles(
            connection,
            known.userId,
            identity,
            provisioned,
          ),
        };
      }
      const email = identity.email ? normalizeEmail(identity.email) : undefined;
      if (!email) {
        throw new SsoRefused('no_email');
      }
      // Before `emailVerified` is read: `verified-domains` relies on it.
      if (!(await this.domains.isVerified(emailDomain(email)))) {
        throw new SsoRefused('domain_unverified');
      }
      // SAML has no such claim: the verified domain above is its trust. An
      // OAuth 2.0 connection says by its mapping (`emailVerified`), whose
      // `verified-domains` mode is that same trust.
      if (connection.protocol !== 'saml' && !identity.emailVerified) {
        throw new SsoRefused('email_unverified');
      }
      const existing = await this.repository.findUserByEmail(email);
      let userId: string;
      if (existing) {
        if (!existing.active) {
          throw new SsoRefused('account_inactive');
        }
        // Whoever registered an address without proving it must not get its
        // owner's sign-ins (account pre-hijacking): they prove it first.
        if (!existing.emailVerified) {
          throw new SsoRefused('account_unverified');
        }
        userId = existing.id;
      } else {
        if (!connection.jitProvisioning) {
          throw new SsoRefused('not_a_member');
        }
        const created = await this.repository.insertUser({
          email,
          name: identity.name?.trim() || email,
          passwordHash: null,
          emailVerified: true,
        });
        userId = created.id;
        await this.audit.record(asActor(created), {
          action: 'user.signed-up',
          targetType: 'user',
          targetId: userId,
          details: { via: 'sso', connectionId: connection.id },
        });
      }
      const provisioned = await this.ensureMember(connection, userId, identity);
      await this.repository.insertIdentity({
        connectionId: connection.id,
        subject: identity.subject,
        userId,
      });
      await this.audit.record(null, {
        action: 'user.identity-linked',
        targetType: 'user',
        targetId: userId,
        details: {
          provider: ssoProvider(connection.id),
          connectionId: connection.id,
          tenantId,
        },
      });
      return {
        userId,
        rolesChanged: await this.syncRoles(
          connection,
          userId,
          identity,
          provisioned,
        ),
      };
    });
  }

  /**
   * The roles the connection gives (README.md, "Roles from the IdP"), in
   * the sign-in's transaction; whether any grant changed.
   *
   * - A member it just provisioned gets its default roles (`group` null),
   *   once: theirs to keep, as an invitation's.
   * - With group mappings, at every sign-in: the roles of the groups the IdP
   *   lists are granted (marked in `sso_role_grants`), and those a mapping of
   *   this connection granted whose group it no longer lists are taken back.
   *   A role the member holds otherwise (an administrator's grant) is left
   *   alone, given or not. Without group mappings nothing is touched.
   * - Taking back the tenant's last administrator role is skipped (a
   *   savepoint, audited): the IdP can't lock the tenant out.
   *
   * No grant check here: the administrator who set the mappings had to be
   * able to grant each role (SsoConnectionsService).
   */
  private async syncRoles(
    connection: SsoConnection,
    userId: string,
    identity: SsoIdentity,
    provisioned: boolean,
  ) {
    const mappings = await this.connections.roleMappingsOf(connection.id);
    if (mappings.length === 0) {
      return false;
    }
    const now = new Date();
    // A grant that ended counts as none (a later grant replaces it).
    await this.repository.deleteEndedRoles(connection.tenantId, userId, now);
    const held = new Set(
      await this.repository.roleIdsOf(connection.tenantId, userId),
    );
    const added: string[] = [];
    if (provisioned) {
      const defaults = mappings
        .filter((mapping) => mapping.group === null)
        .map((mapping) => mapping.roleId)
        .filter((roleId) => !held.has(roleId));
      if (defaults.length > 0) {
        await this.repository.grantRoles(userId, defaults);
        defaults.forEach((roleId) => held.add(roleId));
        added.push(...defaults);
      }
    }
    const grouped = mappings.filter((mapping) => mapping.group !== null);
    let removed: string[] = [];
    let kept: string[] = [];
    if (grouped.length > 0) {
      const listed = new Set(identity.groups ?? []);
      const wanted = new Set(
        grouped
          .filter((mapping) => listed.has(mapping.group!))
          .map((mapping) => mapping.roleId),
      );
      const granting = [...wanted].filter((roleId) => !held.has(roleId));
      if (granting.length > 0) {
        await this.repository.grantRoles(userId, granting);
        await this.repository.markGrants(connection.id, userId, granting);
        added.push(...granting);
      }
      const ours = await this.repository.markedRoleIds(connection.id, userId);
      const taking = ours.filter((roleId) => !wanted.has(roleId));
      if (taking.length > 0) {
        try {
          // A savepoint: refused, the grants stay and the sign-in goes on.
          await this.txHost.withTransaction(Propagation.Nested, async () => {
            await this.repository.revokeRoles(userId, taking);
            await this.roles.assertAnAdministratorRemains();
          });
          removed = taking;
        } catch (error) {
          if (!(error instanceof ConflictException)) {
            throw error;
          }
          kept = taking;
        }
      }
    }
    if (added.length === 0 && removed.length === 0 && kept.length === 0) {
      return false;
    }
    await this.audit.record(null, {
      action: 'sso.roles-synced',
      targetType: 'user',
      targetId: userId,
      details: {
        connectionId: connection.id,
        added,
        removed,
        // Not taken back: the tenant's last administrator.
        ...(kept.length > 0 && { keptLastAdministrator: kept }),
      },
    });
    return added.length > 0 || removed.length > 0;
  }

  /**
   * The user is an active member of the connection's tenant: already, or
   * now (just-in-time, for an address of a verified domain; true). A
   * deactivated membership (deprovisioned) is refused, never brought back
   * by a sign-in.
   */
  private async ensureMember(
    connection: SsoConnection,
    userId: string,
    identity: SsoIdentity,
  ) {
    // Locked: a concurrent sign-in or SCIM change waits for this one.
    const membership = await this.repository.lockMembership(
      connection.tenantId,
      userId,
    );
    if (membership) {
      if (!membership.active) {
        throw new SsoRefused('membership_inactive');
      }
      return false;
    }
    if (!connection.jitProvisioning) {
      throw new SsoRefused('not_a_member');
    }
    // A known identity whose membership went (an administrator removed it)
    // comes back only as a new person would: an address of a verified domain.
    const account = await this.repository.lockUser(userId);
    if (
      !account ||
      !(await this.domains.isVerified(emailDomain(account.email)))
    ) {
      throw new SsoRefused('domain_unverified');
    }
    if (!account.active) {
      throw new SsoRefused('account_inactive');
    }
    await this.repository.insertMembership(connection.tenantId, userId);
    await this.audit.record(asActor(account), {
      action: 'member.provisioned',
      targetType: 'user',
      targetId: userId,
      details: {
        via: 'sso',
        connectionId: connection.id,
        subject: identity.subject,
      },
    });
    this.logger.log('Member provisioned just in time', {
      userId,
      connectionId: connection.id,
    });
    return true;
  }

  /**
   * Signs the browser in (the package's SignInService: the session cookie,
   * the previous session ended), in the connection's tenant, as `sso` by
   * this connection, at the IdP's authentication time when it told one.
   */
  async signIn(
    connection: SsoConnection,
    userId: string,
    context: {
      ip: string;
      userAgent: string | undefined;
      authenticatedAt?: Date | null;
    },
  ) {
    const method = ssoProvider(connection.id);
    await this.signInService.signIn(userId, {
      method,
      metadata: {
        ...methodMetadata(method),
        tenantId: connection.tenantId,
        authenticatedAt: (context.authenticatedAt ?? new Date()).toISOString(),
      },
    });
    const user = await this.users.inTenant(userId, connection.tenantId);
    if (user) {
      // Audited (member.signed-in) and alerted as any sign-in.
      await this.events.emitAsync(AUTH_EVENTS.signedIn, {
        user,
        method,
        ip: context.ip,
        userAgent: context.userAgent,
        tenantId: connection.tenantId,
      } satisfies SignedInEvent);
    }
  }

  /** Who signed in through the connection: its identities' accounts. */
  async usersOf(connectionId: string) {
    return this.repository.usersOf(connectionId);
  }

  /**
   * Ends what `userIds` signed in to through the connection, when it is
   * turned off or deleted: their browser sessions (`method: sso`,
   * `provider: <connection id>`, through SessionService) and their token
   * clients' refresh families (claim `method: sso:<connection id>`). The
   * package's TokenService revokes one token or all of a user's, so the
   * families are found in iam/auth's table and revoked through its store,
   * as iam/account's sign-out of one app does. Other sign-ins stay.
   */
  async endSessions(connectionId: string, userIds: readonly string[]) {
    if (userIds.length === 0) return;
    const families = await this.repository.liveFamilies(
      [...userIds],
      ssoProvider(connectionId),
    );
    // The store announces each family's end (`auth.token-session-ended`).
    for (const { familyId } of families) {
      await this.store.revokeRefreshTokenFamily(familyId);
    }
    for (const userId of userIds) {
      for (const session of await this.sessions.list(userId)) {
        const authentication = authenticationOf(session);
        if (
          authentication?.method === 'sso' &&
          authentication.provider === connectionId
        ) {
          await this.sessions.revoke(session.id, { userId });
        }
      }
    }
  }

  /** A refused sign-in, in the tenant's audit log: who (as the IdP named them) and why. */
  async refused(
    connection: SsoConnection,
    label: string,
    reason: string,
    ip: string,
  ) {
    await this.audit.recordAnonymous(label.slice(0, 320), {
      action: 'auth.sign-in-failed',
      targetType: 'sso-connection',
      targetId: connection.id,
      details: {
        method: ssoProvider(connection.id),
        protocol: connection.protocol,
        reason,
      },
      ip,
    });
  }
}

/** The audit log's actor for an account (no principal yet). */
const asActor = (row: typeof users.$inferSelect) =>
  ({
    kind: 'user',
    id: row.id,
    email: row.email,
    name: row.name,
  }) as UserPrincipal;
