import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpClientModule } from '@nestjs/http-client';
import { switchFeature } from '../../core/http/feature.js';
import { httpConfig } from '../../core/http/http.config.js';
import { MailModule } from '../../core/mail/mail.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CaptchaModule } from '../captcha/captcha.module.js';
import { AccountParts } from './account.parts.js';
import { AccountPersonalData } from './account.personal-data.js';
import { accountConfig } from './account.config.js';
import { AccountFlowContext } from './account-flow.context.js';
import {
  EmailVerificationMailer,
  MagicLinkMailer,
  OidcAccounts,
  PasswordResetMailer,
} from './account.handlers.js';
import {
  InvitationMail,
  MagicLinkMail,
  ResetPasswordMail,
  SecurityAlertMail,
  VerifyEmailMail,
} from './account.mails.js';
import { AccountOperations } from './account.operations.js';
import { AccountOptions } from './account.options.js';
import { AccountService } from './account.service.js';
import { AccountStores } from './account.stores.js';
import { AccountRepository } from './account.repository.js';
import { PasskeysRepository } from './passkeys.repository.js';
import { AccountWork } from './account-work.js';
import {
  BreachedPasswordsService,
  PWNED_PASSWORDS,
} from './breached-passwords.service.js';
import { EmailController } from './email.controller.js';
import { MagicLinkController } from './magic-link.controller.js';
import { MfaController } from './mfa.controller.js';
import { NativeHandoffs } from './native-handoff.js';
import { NativeSignIn } from './native-sign-in.service.js';
import { OidcController } from './oidc.controller.js';
import { ProviderReauthentications } from './oidc-reauthentication.js';
import { PasskeysController } from './passkeys.controller.js';
import { PasskeysService } from './passkeys.service.js';
import { ProfileController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';
import { PasswordController } from './password.controller.js';
import { PasswordHashLimiter } from './password-hashing.js';
import { PasswordHistoryService } from './password-history.service.js';
import { OidcSignIn } from './oidc-sign-in.service.js';
import { ProviderSignIn } from './provider-sign-in.service.js';
import { ReauthenticationController } from './reauthentication.controller.js';
import { ReauthenticationService } from './reauthentication.service.js';
import { SecurityAlerts } from './security-alerts.service.js';
import { SessionsController } from './sessions.controller.js';
import { SignInPasswordCheck } from './sign-in-password-check.js';
import { SignUpMail } from './sign-up-mail.listener.js';
import { TokensController } from './tokens.controller.js';
import { VerificationRequests } from './verification-requests.service.js';
import { WellKnownController } from './well-known.controller.js';

const accountFeature = ConfigModule.forFeature(accountConfig);

/**
 * The signed-in user's account (README.md): passwords, email, sessions,
 * tokens for apps, two-factor, passkeys, magic links, providers,
 * re-authentication, security alerts. Builds on iam/auth (the
 * authentication package, sessions, tokens) and adds its options
 * (`@AuthenticationOptionsPart`), its stores and handlers. Needs
 * QueuesModule (mail), Redis, core/encryption (DATA_ENCRYPTION_KEYS: the
 * TOTP secrets) and EventEmitterModule.
 */
@Module({
  imports: [
    accountFeature,
    ConfigModule.forFeature(httpConfig),
    MailModule,
    AuditModule,
    // Who-am-I's `can` (AccountParts) and the sign-in page's captcha settings.
    AccessModule,
    CaptchaModule,
    // One attempt, no retries: the user waits on it, and
    // PASSWORD_BREACH_ON_ERROR decides the rest.
    HttpClientModule.registerAsync({
      name: PWNED_PASSWORDS,
      imports: [accountFeature],
      inject: [accountConfig.KEY],
      useFactory: (config: ReturnType<typeof accountConfig>) => ({
        baseUrl: config.breachCheck.apiUrl,
        timeout: config.breachCheck.timeoutMs,
        retry: false,
      }),
    }),
  ],
  controllers: [
    PasswordController,
    EmailController,
    SessionsController,
    TokensController,
    MfaController,
    MagicLinkController,
    ReauthenticationController,
    OidcController,
    PasskeysController,
    WellKnownController,
    ProfileController,
  ],
  providers: [
    AccountOptions,
    AccountStores,
    AccountRepository,
    PasskeysRepository,
    AccountWork,
    AccountFlowContext,
    AccountService,
    PasswordResetMailer,
    EmailVerificationMailer,
    MagicLinkMailer,
    OidcAccounts,
    ResetPasswordMail,
    InvitationMail,
    VerifyEmailMail,
    MagicLinkMail,
    SecurityAlertMail,
    SecurityAlerts,
    BreachedPasswordsService,
    SignInPasswordCheck,
    PasswordHashLimiter,
    PasswordHistoryService,
    VerificationRequests,
    ReauthenticationService,
    PasskeysService,
    ProviderReauthentications,
    ProviderSignIn,
    OidcSignIn,
    NativeHandoffs,
    NativeSignIn,
    SignUpMail,
    ProfileService,
    AccountParts,
    AccountPersonalData,
    AccountOperations,
    switchFeature(
      'mfa',
      'Two-factor enrollment (`/v1/auth/mfa/enroll`; AUTH_MFA). Off: enrolled users are still asked for a code.',
      'account.mfa',
    ),
    switchFeature(
      'passkeys',
      'Passkeys (`/v1/auth/passkeys`; PASSKEYS).',
      'account.passkeys.enabled',
    ),
    switchFeature(
      'magicLink',
      'Sign-in by email link (`POST /v1/auth/magic-link`; AUTH_MAGIC_LINK).',
      'account.magicLink',
    ),
  ],
  exports: [AccountOperations],
})
export class AccountModule {}
