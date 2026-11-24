import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  EmailVerificationService,
  MagicLinkService,
  MfaService,
  PasswordHasher,
  PasswordResetService,
  type SessionRecord,
  SessionService,
  SignInService,
  TokenService,
} from '@nestjs/authentication';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { t } from '@nestjs/i18n';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { and, eq, gt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { isSafeRedirectPath } from '../../core/http/redirect-path.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AUTH_EVENTS,
  type SignedInEvent,
  type SignInFailedEvent,
} from '../auth/auth.events.js';
import { refreshTokens, users } from '../auth/auth.tables.js';
import {
  authenticationOf,
  isSessionRecord,
  tokenClaims,
} from '../auth/authentication-method.js';
import { AuthPolicy } from '../auth/auth-policy.js';
import { DrizzleAuthenticationStore } from '../auth/drizzle-authentication.store.js';
import { sessionTenant } from '../auth/impersonation.js';
import { isPlaceholderEmail } from '../auth/onboarding.js';
import { PasswordSignIn } from '../auth/password-sign-in.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { SignInContext } from '../auth/sign-in-context.js';
import { SignInGates } from '../auth/sign-in-gate.js';
import { tokenSessionId } from '../auth/token-session.js';
import { normalizeEmail, UsersRepository } from '../auth/users.repository.js';
import { AccountUsers } from './account.users.js';
import { AccountWork } from './account-work.js';
import { BreachedPasswordsService } from './breached-passwords.service.js';
import { deviceLabel } from './devices.js';
import { PasswordHashLimiter } from './password-hashing.js';
import { PasswordHistoryService } from './password-history.service.js';
import { ReauthenticationService } from './reauthentication.service.js';
import { SecurityAlerts } from './security-alerts.service.js';

/** The request a change or a sign-in comes from. */
export interface RequestContext {
  ip: string;
  userAgent: string | undefined;
}

/**
 * What people do to their own account: passwords (a change, a reset or
 * invitation link), their address (verification, the first
 * administrator's placeholder), where they're signed in, two-factor, and
 * the token and magic-link sign-ins. Each change is one transaction with
 * its audit entry, in no tenant (AccountWork); the owner is told by mail
 * after the commit (SecurityAlerts). Administrators' changes to others'
 * accounts are another module's.
 */
@Injectable()
export class AccountService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly users: UsersRepository,
    private readonly accounts: AccountUsers,
    private readonly work: AccountWork,
    private readonly audit: AuditService,
    private readonly securityAlerts: SecurityAlerts,
    private readonly passwords: PasswordSignIn,
    private readonly passwordHasher: PasswordHasher,
    private readonly signInService: SignInService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly store: DrizzleAuthenticationStore,
    private readonly mfa: MfaService,
    private readonly magicLinks: MagicLinkService,
    private readonly passwordReset: PasswordResetService,
    private readonly emailVerification: EmailVerificationService,
    private readonly breachedPasswords: BreachedPasswordsService,
    private readonly passwordHistory: PasswordHistoryService,
    private readonly hashLimiter: PasswordHashLimiter,
    private readonly signInContext: SignInContext,
    private readonly reauthentication: ReauthenticationService,
    private readonly events: EventEmitter2,
    private readonly gates: SignInGates,
    private readonly policy: AuthPolicy,
  ) {}

  // Passwords

  /**
   * A password set with a reset or invitation link (PasswordResetService):
   * refused before the link is spent when it repeats a recent one or is
   * found in data breaches, then a 400 for an unknown, used or expired link.
   *
   * The hashing slot is taken before the link: the package consumes the
   * token, then hashes the new password, so a 503 server_busy from a full
   * hashing queue there would spend the link. Busy now, the link is
   * untouched and the retry works.
   */
  async resetPassword(token: string, password: string, ip: string) {
    const userId = await this.accounts.pendingReset(token);
    if (userId) {
      // The tenants' minimum length: the account's, for a reset or an invitation's link alike.
      await this.policy.assertPasswordLength(password, 'password', { userId });
      await this.passwordHistory.assertNotReused(userId, password, 'password');
    }
    await this.breachedPasswords.assertNotBreached(password, 'password');
    const result = await this.hashLimiter.run(() =>
      this.passwordReset.reset(token, password),
    );
    if (!result) {
      throw new BadRequestException(t('account.invalidLink'));
    }
    await this.passwordWasReset(result.userId, ip);
  }

  /** After a reset link set the password: the link went to the address and came back, so it's verified. */
  private async passwordWasReset(userId: string, ip: string) {
    const user = await this.users.findActive(userId);
    const alert = await this.work.run(async () => {
      await this.db
        .update(users)
        // A reset link also replaces the generated password and proved the
        // address: the first administrator's onboarding is done as far as it can be.
        .set({
          emailVerified: true,
          onboardingPassword: false,
          ...(user &&
            !isPlaceholderEmail(user.email) && { onboardingEmail: false }),
        })
        .where(eq(users.id, userId));
      return this.securityAlerts.credentialsChanged(user, userId, {
        action: 'auth.password-reset',
        ip,
        alert: 'passwordChanged',
        // An invitation's first password is no news to anyone.
        onlyIfUsed: true,
      });
    });
    await this.securityAlerts.tell(alert);
  }

  /**
   * A new password, checked against the current one (when the account has
   * one), the history and the breaches: the hash, its audit entry and the
   * owner's alert in one transaction. After the commit, every other
   * session and every token client is signed out and this browser's
   * session gets a new id.
   */
  async changePassword(
    user: UserPrincipal,
    session: SessionRecord | undefined,
    passwords: { currentPassword?: string; newPassword: string },
    ip: string,
  ) {
    const found = await this.users.findActiveByEmail(user.email);
    if (found?.passwordHash) {
      const valid = await this.passwordHasher.verify(
        passwords.currentPassword ?? '',
        found.passwordHash,
      );
      if (!valid) {
        throw new ForbiddenException(t('account.wrongPassword'));
      }
    }
    await this.policy.assertPasswordLength(
      passwords.newPassword,
      'newPassword',
      { userId: user.id },
    );
    await this.passwordHistory.assertNotReused(
      user.id,
      passwords.newPassword,
      'newPassword',
    );
    await this.breachedPasswords.assertNotBreached(
      passwords.newPassword,
      'newPassword',
    );
    const hash = await this.passwordHasher.hash(passwords.newPassword);
    const alert = await this.work.run(async () => {
      await this.passwordHistory.replaced(user.id);
      await this.accounts.replacePassword(user.id, hash);
      return this.securityAlerts.credentialsChanged(user, user.id, {
        action: 'auth.password-changed',
        ip,
        alert: 'passwordChanged',
      });
    });
    await this.sessions.revokeAll(user.id, {
      ...(session && { except: session.id }),
    });
    await this.tokens.revokeAll(user.id);
    if (session) {
      await this.signInService.rotateSession();
    }
    await this.securityAlerts.tell(alert);
  }

  // Email

  /**
   * Proves an address with its verification link. An account whose password
   * was chosen before its address was proved must also give that password:
   * the link alone proves the mailbox, not who chose the password. Checked
   * before the package spends the link, so a missing or wrong password
   * leaves it usable.
   */
  async verifyEmail(token: string, password: string | undefined) {
    const pending = await this.accounts.pendingVerification(token);
    if (pending?.passwordHash && !pending.emailVerified) {
      if (!password) {
        throw new BadRequestException({
          code: 'password_required',
          message: t('account.required'),
          errors: [{ path: 'password', message: t('account.required') }],
        });
      }
      const valid = await this.passwordHasher.verify(
        password,
        pending.passwordHash,
      );
      if (!valid) {
        throw new ForbiddenException(t('account.wrongPassword'));
      }
    }
    const verified = await this.emailVerification.verify(token);
    if (!verified) {
      throw new BadRequestException(t('account.invalidLink'));
    }
    return verified;
  }

  /**
   * The first administrator's onboarding: the placeholder address becomes
   * `email`, unproved, and its verification link goes there. Wants the
   * current password. The change and its audit entry are one transaction;
   * the mail follows.
   */
  async changeOnboardingEmail(
    user: UserPrincipal,
    input: { email: string; currentPassword: string },
  ) {
    if (!user.onboarding?.email) {
      throw new ConflictException(t('account.onboardingNotPending'));
    }
    const email = normalizeEmail(input.email);
    if (isPlaceholderEmail(email)) {
      throw new BadRequestException({
        code: 'placeholder_email',
        message: t('account.placeholderEmail'),
        errors: [{ path: 'email', message: t('account.placeholderEmail') }],
      });
    }
    const found = await this.users.findActiveByEmail(user.email);
    const valid = await this.passwordHasher.verify(
      input.currentPassword,
      found?.passwordHash ?? undefined,
    );
    if (!valid || !found?.passwordHash) {
      throw new ForbiddenException(t('account.wrongPassword'));
    }
    if (email !== user.email && (await this.accounts.findByEmail(email))) {
      throw new ConflictException(t('account.emailTaken'));
    }
    await this.work.run(async () => {
      await this.db
        .update(users)
        .set({ email, emailVerified: false })
        .where(eq(users.id, user.id));
      await this.audit.record(user, {
        action: 'user.email-changed',
        targetType: 'user',
        targetId: user.id,
        details: { from: user.email, to: email, via: 'onboarding' },
      });
    });
    await this.emailVerification.send({ id: user.id, email });
  }

  // Sessions

  /**
   * Where the user is signed in: their browser sessions, with a readable
   * `device` from the recorded user agent, then their apps (token families
   * still signed in: `id` the family's `sid`, `device` the one it signed
   * in from, the last refresh as its last activity). `current`: the
   * caller's own session or family. While an administrator acts as the
   * user: only that session.
   */
  async listSessions(user: UserPrincipal, current: unknown) {
    const currentId = isSessionRecord(current) ? current.id : undefined;
    const currentSid = (current as { sid?: unknown } | undefined)?.sid;
    const browsers = (await this.sessions.list(user.id))
      // The list also holds the sessions in which they act as someone else.
      .filter((session) => session.userId === user.id)
      .filter((session) => !user.impersonator || session.id === currentId)
      .map((session) => {
        const authentication = authenticationOf(session);
        const userAgent =
          (session.metadata?.userAgent as string | undefined) ?? null;
        return {
          id: session.id,
          kind: 'browser' as const,
          createdAt: session.createdAt.toISOString(),
          lastActiveAt: session.lastActiveAt.toISOString(),
          userAgent,
          device: deviceLabel(userAgent),
          method: authentication?.method ?? null,
          provider: authentication?.provider ?? null,
          mfa: authentication?.mfa ?? false,
          authenticatedAt:
            authentication?.authenticatedAt?.toISOString() ?? null,
          current: session.id === currentId,
        };
      });
    if (user.impersonator) {
      return browsers;
    }
    const apps = (await this.liveTokenFamilies(user.id)).flatMap(
      ({ startedAt, lastRefreshAt, claims }) => {
        // A family signed in before `sid` existed can't be named: not listed.
        if (typeof claims?.sid !== 'string') {
          return [];
        }
        const authentication = authenticationOf({ sub: user.id, ...claims });
        return [
          {
            id: claims.sid,
            kind: 'app' as const,
            createdAt: startedAt.toISOString(),
            lastActiveAt: lastRefreshAt.toISOString(),
            userAgent: null,
            device: typeof claims.dev === 'string' ? claims.dev : null,
            method: authentication?.method ?? null,
            provider: authentication?.provider ?? null,
            mfa: authentication?.mfa ?? false,
            authenticatedAt:
              authentication?.authenticatedAt?.toISOString() ?? null,
            current: claims.sid === currentSid,
          },
        ];
      },
    );
    return [...browsers, ...apps];
  }

  /**
   * Signs one of the user's sessions out: a browser session by its id, else
   * an app's token family by its `sid`. False when neither is the user's.
   */
  async revokeSession(user: UserPrincipal, id: string) {
    return (
      (await this.sessions.revoke(id, { userId: user.id })) ||
      (await this.revokeTokenSession(user.id, id))
    );
  }

  /** The user's token families still signed in: when each started and was last refreshed, with its claims. */
  private async liveTokenFamilies(userId: string) {
    const rows = await this.db
      .select({
        familyId: refreshTokens.familyId,
        createdAt: refreshTokens.createdAt,
        claims: refreshTokens.claims,
      })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.revoked, false),
          gt(refreshTokens.familyExpiresAt, new Date()),
        ),
      );
    const families = new Map<
      string,
      {
        startedAt: Date;
        lastRefreshAt: Date;
        claims: Record<string, unknown> | null;
      }
    >();
    for (const row of rows) {
      const family = families.get(row.familyId);
      if (!family) {
        families.set(row.familyId, {
          startedAt: row.createdAt,
          lastRefreshAt: row.createdAt,
          claims: row.claims as Record<string, unknown> | null,
        });
        continue;
      }
      if (row.createdAt < family.startedAt) {
        family.startedAt = row.createdAt;
      }
      if (row.createdAt > family.lastRefreshAt) {
        family.lastRefreshAt = row.createdAt;
        family.claims = row.claims as Record<string, unknown> | null;
      }
    }
    return [...families.values()].sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
    );
  }

  /** Revokes the user's token families of the session `sid`; false when none is theirs. */
  private async revokeTokenSession(userId: string, sid: string) {
    const families = await this.db
      .selectDistinct({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.revoked, false),
          eq(tokenSessionId, sid),
        ),
      );
    if (families.length === 0) {
      return false;
    }
    // The store announces each family's end (`auth.token-session-ended`).
    for (const { familyId } of families) {
      await this.store.revokeRefreshTokenFamily(familyId);
    }
    return true;
  }

  // Two-factor

  /**
   * Two-factor on, with a first code from the app; returns the recovery
   * codes. The code's check commits by itself; then the recovery codes,
   * the audit entry and the owner's alert are one transaction.
   */
  async enableMfa(user: UserPrincipal, code: string, ip: string) {
    // Outside the transaction: a wrong code counts towards the lockout
    // (recorded by the package before the check); a rollback would forget it.
    if (!(await this.signInService.confirmMfa(user.id, code))) {
      throw new BadRequestException(t('account.invalidCode'));
    }
    let recoveryCodes: string[] = [];
    const alert = await this.work.run(async () => {
      recoveryCodes = await this.mfa.generateRecoveryCodes(user.id);
      return this.securityAlerts.credentialsChanged(user, user.id, {
        action: 'auth.mfa-enabled',
        ip,
        alert: 'mfaEnabled',
      });
    });
    await this.securityAlerts.tell(alert);
    return recoveryCodes;
  }

  /**
   * Two-factor off, its audit entry and the owner's alert in one
   * transaction; then the tokens issued with the second factor, which
   * would keep claiming it, are revoked.
   */
  async disableMfa(user: UserPrincipal, ip: string) {
    const alert = await this.work.run(async () => {
      await this.mfa.disable(user.id);
      return this.securityAlerts.credentialsChanged(user, user.id, {
        action: 'auth.mfa-disabled',
        ip,
        alert: 'mfaDisabled',
      });
    });
    await this.tokens.revokeAll(user.id);
    await this.securityAlerts.tell(alert);
  }

  /** New recovery codes (the old ones stop working), audited. */
  async newRecoveryCodes(user: UserPrincipal) {
    return this.work.run(async () => {
      const codes = await this.mfa.generateRecoveryCodes(user.id);
      await this.audit.record(user, {
        action: 'auth.mfa-recovery-codes',
        targetType: 'user',
        targetId: user.id,
      });
      return codes;
    });
  }

  /**
   * The second step of a sign-in with two-factor on: the package verifies
   * the code and rotates the pending session to `verified`. The sign-in
   * completes now, so now is when the user proved who they are (step-up).
   * `null`: no pending session, or a wrong code.
   */
  async completeMfa(body: { code?: string; recoveryCode?: string }) {
    const issued = await this.signInService.completeMfa(body);
    if (issued) {
      await this.reauthentication.stampAuthenticated(
        issued.session.id,
        new Date(),
      );
    }
    return issued;
  }

  // Sign-ins

  /**
   * A token client's sign-in with a password (and its second factor when
   * two-factor is on): the user, or a 401 (PasswordSignIn); the tokens,
   * announced as any sign-in. The tenant asked for, when the user is a
   * member (else the same 401 as a wrong password: nothing about tenants
   * is told before a sign-in); else the last chosen. Either way one that
   * lets a password in (`@SignInGate()`: 403 `sso_required`).
   */
  async issueTokens(
    email: string,
    password: string,
    secondFactor: { code?: string; recoveryCode?: string },
    context: RequestContext,
    tenantId?: string,
  ) {
    const user = await this.passwords.verify(email, password, context.ip);
    const tenant =
      tenantId === undefined
        ? await this.gates.tenantFor(user, 'password', context.ip)
        : (await this.users.isMember(user.id, tenantId))
          ? tenantId
          : null;
    if (tenantId !== undefined && !tenant) {
      await this.events.emitAsync(AUTH_EVENTS.signInFailed, {
        email,
        user,
        method: 'password',
        ip: context.ip,
      } satisfies SignInFailedEvent);
      throw new UnauthorizedException(t('auth.invalidCredentials'));
    }
    if (tenantId !== undefined && tenant) {
      await this.gates.assert(user, tenant, 'password', context.ip);
    }
    const tokens = await this.tokens.issue(user.id, {
      method: 'password',
      // How, when and where, for every token of the family (step-up reads
      // auth_time, JwtAuth the tenant).
      claims: tokenClaims(['pwd'], new Date(), tenant, {
        device: deviceLabel(context.userAgent),
      }),
      secondFactor,
    });
    await this.events.emitAsync(AUTH_EVENTS.signedIn, {
      user,
      method: 'password',
      ip: context.ip,
      userAgent: context.userAgent,
      tenantId: tenant,
    } satisfies SignedInEvent);
    return tokens;
  }

  /**
   * A sign-in by email link, in the browser that asked for it (the
   * package's cookie): a 401 for a link unknown, used, expired or from
   * another browser; else the session, announced as any sign-in.
   */
  async signInWithMagicLink(token: string, context: RequestContext) {
    // The package signs in inside consume(): the context names the method.
    const issued = await this.signInContext.run('magic-link', () =>
      this.magicLinks.consume(token),
    );
    if (!issued) {
      throw new UnauthorizedException(t('account.invalidLink'));
    }
    const user = await this.users.findActive(issued.session.userId);
    if (user) {
      await this.events.emitAsync(AUTH_EVENTS.signedIn, {
        user,
        method: 'magic-link',
        ip: context.ip,
        userAgent: context.userAgent,
        tenantId: sessionTenant(issued.session),
      } satisfies SignedInEvent);
    }
    const mfaRequired = issued.session.mfa === 'pending';
    return {
      signedIn: !mfaRequired,
      mfaRequired,
      // Checked again: a link stored before the rule answers none.
      redirectTo: isSafeRedirectPath(issued.redirectTo)
        ? issued.redirectTo
        : undefined,
    };
  }
}
