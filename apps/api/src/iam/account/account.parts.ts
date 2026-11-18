import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { MfaService } from '@nestjs/authentication';
import { AccessService } from '../access/access.service.js';
import { PermissionCatalog } from '../access/permission-catalog.js';
import {
  SignInMethodsPart,
  type SignInMethodsProvider,
  WhoAmIPart,
  type WhoAmIProvider,
  type WhoAmIRequest,
} from '../auth/who-am-i.js';
import { CaptchaService } from '../captcha/captcha.service.js';
import { accountConfig } from './account.config.js';
import { AccountUsers } from './account.users.js';
import { oidcProviders } from './oidc.providers.js';
import { ReauthenticationService } from './reauthentication.service.js';

/**
 * What iam/account adds to who-am-I (`GET /v1/auth/me`) and to the sign-in
 * methods (`GET /v1/auth/methods`): its factors, how this credential was
 * authenticated, what the user may do, and the ways in it offers.
 */
@WhoAmIPart(['mfaEnabled', 'hasPassword', 'authentication', 'can'])
@SignInMethodsPart(['magicLink', 'passkeys', 'providers', 'captcha'])
@Injectable()
export class AccountParts implements WhoAmIProvider, SignInMethodsProvider {
  constructor(
    private readonly mfa: MfaService,
    private readonly accounts: AccountUsers,
    private readonly reauthentication: ReauthenticationService,
    private readonly access: AccessService,
    private readonly catalog: PermissionCatalog,
    private readonly captcha: CaptchaService,
    @Inject(accountConfig.KEY)
    private readonly config: ConfigType<typeof accountConfig>,
  ) {}

  async whoAmI({ user, session }: WhoAmIRequest) {
    const { authentication, recentUntil } =
      this.reauthentication.status(session);
    const [mfaEnabled, account, can] = await Promise.all([
      this.mfa.isEnrolled(user.id),
      this.accounts.find(user.id),
      this.abilities(user),
    ]);
    return {
      mfaEnabled,
      // What the deletion and the password change ask for again.
      hasPassword: !!account?.passwordHash,
      authentication: authentication && {
        ...authentication,
        authenticatedAt: authentication.authenticatedAt?.toISOString() ?? null,
        // An impersonation never counts as recent.
        recentUntil:
          user.impersonator || !recentUntil ? null : recentUntil.toISOString(),
      },
      can,
    };
  }

  signInMethods() {
    return {
      magicLink: this.config.magicLink,
      passkeys: this.config.passkeys.enabled,
      providers: Object.keys(oidcProviders(this.config)),
      captcha: this.captcha.settings(),
    };
  }

  /**
   * Every action of the catalog as `Subject.action`: true when one of the
   * user's permissions allows it, on some records at least. Access
   * management is never offered while impersonating (its policies refuse it).
   */
  private async abilities(user: WhoAmIRequest['user']) {
    const entries = await Promise.all(
      Object.entries(this.catalog.subjects).flatMap(([subject, declared]) =>
        Object.keys(declared.actions).map(
          async (action) =>
            [
              `${subject}.${action}`,
              !(user.impersonator && subject === 'Access') &&
                (await this.access.can(user, action, subject)),
            ] as const,
        ),
      ),
    );
    return Object.fromEntries(entries) as Record<string, boolean>;
  }
}
