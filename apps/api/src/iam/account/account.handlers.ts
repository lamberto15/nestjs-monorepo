import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AuthenticationRegistry,
  EmailVerificationHandler,
  type EmailVerificationLink,
  MagicLinkHandler,
  type MagicLink,
  type OAuthTokens,
  OidcAccountResolver,
  type OidcProfile,
  type OidcResolveContext,
  PasswordResetHandler,
  type PasswordResetLink,
} from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import { MailQueue } from '../../core/mail/mail.queue.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { authTimeOf, SignInContext } from '../auth/sign-in-context.js';
import { UsersRepository } from '../auth/users.repository.js';
import {
  AccountFlowContext,
  type NativeIdentity,
} from './account-flow.context.js';
import { accountConfig } from './account.config.js';
import {
  InvitationMail,
  MagicLinkMail,
  ResetPasswordMail,
  VerifyEmailMail,
} from './account.mails.js';
import { AccountRepository } from './account.repository.js';
import { AccountWork } from './account-work.js';
import {
  isFreshAuthentication,
  type ProviderReauthentication,
  ReauthenticationRefused,
} from './oidc-reauthentication.js';
import { oidcProviders } from './oidc.providers.js';
import { PasswordHistoryService } from './password-history.service.js';

/** A link mail's data for `user`, sent to `address`. */
const linkMail = (
  user: { name: string; timezone: string | null; locale: string | null },
  address: string,
  link: { url: string; expiresAt: Date },
) => ({
  to: { name: user.name, address },
  data: {
    name: user.name,
    url: link.url,
    expiresAt: link.expiresAt,
    timezone: user.timezone,
  },
  locale: user.locale ?? undefined,
});

/**
 * "Forgot your password?" and invitations: @nestjs/authentication creates
 * and checks the links (PasswordResetService); this sends them. An account
 * without a password gets the invitation email instead of the reset one.
 */
@Injectable()
export class PasswordResetMailer extends PasswordResetHandler {
  constructor(
    private readonly work: AccountWork,
    private readonly mailQueue: MailQueue,
    private readonly accounts: AccountRepository,
    private readonly history: PasswordHistoryService,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerHandler('passwordReset', this);
  }

  async findUser(email: string) {
    const row = await this.accounts.findByEmail(email);
    return row?.active
      ? { id: row.id, email: row.email, passwordHash: row.passwordHash }
      : null;
  }

  async send(link: PasswordResetLink) {
    const user = await this.accounts.find(link.userId);
    if (!user) {
      return;
    }
    const mail = linkMail(user, link.email, link);
    if (user.passwordHash) {
      await this.mailQueue.send(ResetPasswordMail, mail);
    } else {
      await this.mailQueue.send(InvitationMail, mail);
    }
  }

  async updatePassword(userId: string, passwordHash: string) {
    // The replaced hash joins the history in the same transaction.
    await this.work.run(async () => {
      await this.history.replaced(userId);
      await this.accounts.replacePassword(userId, passwordHash);
    });
  }
}

/** Email verification links: sent here, recorded in `users.email_verified`. */
@Injectable()
export class EmailVerificationMailer extends EmailVerificationHandler {
  constructor(
    private readonly mailQueue: MailQueue,
    private readonly accounts: AccountRepository,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerHandler('emailVerification', this);
  }

  async send(link: EmailVerificationLink) {
    const user = await this.accounts.find(link.userId);
    if (!user) {
      return;
    }
    await this.mailQueue.send(
      VerifyEmailMail,
      linkMail(user, link.email, link),
    );
  }

  markVerified(userId: string, email: string) {
    return this.accounts.markEmailVerified(userId, email);
  }

  isVerified(user: unknown) {
    return (user as UserPrincipal).emailVerified === true;
  }
}

/**
 * Passwordless sign-in links, for existing accounts only. Links to an
 * address nobody verified are refused: whoever registered it first must not
 * keep access once its owner signs in (account pre-hijacking).
 */
@Injectable()
export class MagicLinkMailer extends MagicLinkHandler {
  constructor(
    private readonly mailQueue: MailQueue,
    private readonly accounts: AccountRepository,
    @Inject(accountConfig.KEY) config: ConfigType<typeof accountConfig>,
    registry: AuthenticationRegistry,
  ) {
    super();
    // The option and the handler go together (account.options.ts reads the same flag).
    if (config.magicLink) {
      registry.registerHandler('magicLink', this);
    }
  }

  async send(link: MagicLink) {
    const user = await this.accounts.findByEmail(link.email);
    if (!user) {
      return;
    }
    await this.mailQueue.send(MagicLinkMail, linkMail(user, user.email, link));
  }

  async resolveUser(email: string) {
    const row = await this.accounts.findByEmail(email);
    return row?.active && row.emailVerified
      ? { id: row.id, email: row.email }
      : null;
  }
}

/**
 * Sign in with Google, Microsoft or GitHub. An identity is found by
 * (provider, subject). A new one is linked:
 * - to the signed-in user who asked to connect it (`linkTo`);
 * - to the account with the same address, only when the provider verified
 *   the address and so did the account (never by an unverified email);
 * Anything else is refused: there is no sign-up here (an account is
 * created by an administrator's invitation, then signs in with a provider).
 */
@Injectable()
export class OidcAccounts extends OidcAccountResolver {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    @Inject(accountConfig.KEY)
    private readonly config: ConfigType<typeof accountConfig>,
    private readonly signInContext: SignInContext,
    private readonly flow: AccountFlowContext,
    private readonly work: AccountWork,
    registry: AuthenticationRegistry,
  ) {
    super();
    // The option and the resolver go together: only with a provider configured.
    if (Object.keys(oidcProviders(config)).length > 0) {
      registry.registerHandler('oidc', this);
    }
  }

  async resolveUser(
    profile: OidcProfile,
    _tokens: OAuthTokens,
    context: OidcResolveContext,
  ) {
    // A browser's link (the package's), else a native app's (ours).
    const nativeLink = context.linkTo ? undefined : this.flow.linking();
    const linkTo = context.linkTo ?? nativeLink;
    const reauthenticating = linkTo ? undefined : this.flow.reauthenticating();
    if (reauthenticating) {
      return this.reauthenticated(profile, reauthenticating);
    }
    if (!linkTo) {
      this.recordAuthTime(profile);
    }
    const known = await this.accounts.identityOwner(
      profile.provider,
      profile.subject,
    );
    if (known) {
      // Already someone's: connecting it to another account is refused.
      if (linkTo && linkTo.id !== known.userId) {
        return null;
      }
      return known.active ? { id: known.userId } : null;
    }
    if (linkTo) {
      if (nativeLink) {
        // Written when the app completes it (its verifier, its session):
        // a ticket opened in someone else's browser links nothing.
        this.flow.identityToLink({
          provider: profile.provider,
          subject: profile.subject,
          email: profile.email ?? null,
        });
        return { id: linkTo.id };
      }
      return this.link(linkTo.id, profile);
    }
    if (!profile.email || !profile.emailVerified) {
      return null;
    }
    const existing = await this.users.findActiveByEmail(profile.email);
    return existing?.user.emailVerified
      ? this.link(existing.user.id, profile)
      : null;
  }

  /**
   * When the provider authenticated the user: the ID token's `auth_time`
   * (OpenID Connect), when it sends one. A provider may sign the user in
   * from its own session without asking again, so the sign-in here is no
   * proof of a recent one (step-up); the claim
   * says when it was. Without it (GitHub: OAuth 2.0, no ID token; providers
   * that omit it), the sign-in counts as now, a weaker guarantee.
   */
  private recordAuthTime(profile: OidcProfile) {
    const at = authTimeOf(profile.claims);
    if (at) {
      this.signInContext.authenticatedAt(at);
    }
  }

  /**
   * A step-up through the provider (`?reauthenticate=true`): the identity
   * must be one already connected to the user who started it (never a new
   * account, a link by address, or someone else's), and the ID token's
   * `auth_time`, when it has one, after the step-up started: a provider
   * that ignored `prompt=login` and signed in from its own old session is
   * refused, not quietly accepted as a stale sign-in.
   */
  private async reauthenticated(
    profile: OidcProfile,
    expected: ProviderReauthentication,
  ) {
    const known = await this.accounts.identityOwner(
      profile.provider,
      profile.subject,
    );
    if (!known?.active || known.userId !== expected.userId) {
      throw new ReauthenticationRefused('account', expected.redirectTo);
    }
    const authTime = authTimeOf(profile.claims);
    // An OpenID Connect provider issues an ID token, which must carry
    // auth_time here (max_age asked for it); plain OAuth 2.0 (GitHub) has none.
    const kind = oidcProviders(this.config)[profile.provider]?.kind ?? 'oidc';
    if (
      !isFreshAuthentication(authTime, expected.startedAt, {
        requireAuthTime: kind === 'oidc',
      })
    ) {
      throw new ReauthenticationRefused('stale', expected.redirectTo);
    }
    this.recordAuthTime(profile);
    // The new session acts where the re-authenticated one did, while the
    // membership is still active; else the last chosen tenant, as any
    // sign-in.
    if (
      expected.tenantId &&
      (await this.users.isMember(known.userId, expected.tenantId))
    ) {
      this.signInContext.keepTenant(expected.tenantId);
    }
    return { id: known.userId };
  }

  /**
   * A native link its app completed (NativeSignIn.complete()): the
   * identity checked again (another account may have connected it since
   * the callback), then connected. 409 `identity_taken` when it is now
   * someone else's.
   */
  async linkNative(userId: string, identity: NativeIdentity) {
    const known = await this.accounts.identityOwner(
      identity.provider,
      identity.subject,
    );
    if (known?.userId === userId) {
      return;
    }
    if (known) {
      throw new ConflictException({
        code: 'identity_taken',
        message: t('account.identityTaken'),
      });
    }
    await this.link(userId, {
      ...identity,
      email: identity.email ?? undefined,
    });
  }

  private async link(
    userId: string,
    profile: Pick<OidcProfile, 'provider' | 'subject' | 'email'>,
  ) {
    await this.work.run(async () => {
      await this.accounts.insertIdentity({
        provider: profile.provider,
        subject: profile.subject,
        userId,
        email: profile.email ?? null,
      });
      await this.audit.record(null, {
        action: 'user.identity-linked',
        targetType: 'user',
        targetId: userId,
        details: { provider: profile.provider },
      });
    });
    return { id: userId };
  }
}
