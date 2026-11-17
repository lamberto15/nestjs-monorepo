import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import type { Mailable, MailRenderContext } from '@nestjs/mail';
import { EssentialMail } from '../../core/mail/mail.essential.js';
import { accountConfig } from './account.config.js';

/** A link mail's data: who it goes to, the link, and its expiry in their time zone. */
export interface AccountLink {
  name: string;
  url: string;
  expiresAt: Date;
  /** The recipient's time zone (null: UTC): the expiry is shown in it. */
  timezone: string | null;
}

type LinkKind = 'resetPassword' | 'invitation' | 'verifyEmail' | 'magicLink';

/**
 * What the link mails share (template `account-link`): the texts of their
 * kind from the catalog, the link, and its expiry in the recipient's
 * language and time zone. Mail is sent outside the recipient's request, so
 * the locale is always the one passed to `send()`.
 */
@Injectable() // Nest reads the subclasses' dependencies from here.
abstract class AccountLinkMail implements Mailable<AccountLink> {
  protected abstract readonly kind: LinkKind;

  constructor(
    protected readonly i18n: I18nService,
    @Inject(accountConfig.KEY)
    protected readonly config: Pick<
      ConfigType<typeof accountConfig>,
      'serviceName'
    >,
  ) {}

  render(
    { name, url, expiresAt, timezone }: AccountLink,
    { locale }: MailRenderContext,
  ) {
    const app = this.config.serviceName;
    const text = (key: string, args: Record<string, unknown> = {}) =>
      this.i18n.translate(`account.mail.${key}`, { locale, args });
    return {
      subject: text(`${this.kind}.subject`, { app }),
      template: 'account-link',
      context: {
        url,
        greeting: text('greeting', { name }),
        intro: text(`${this.kind}.intro`, { app }),
        action: text(`${this.kind}.action`),
        note: text(`${this.kind}.note`),
        expires: text('expires', {
          expiresAt: this.i18n.formatDate(expiresAt, {
            locale,
            // Intl refuses timeZoneName next to dateStyle/timeStyle: the fields instead.
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: timezone ?? 'UTC',
            timeZoneName: 'short',
          }),
        }),
      },
    };
  }
}

/** Asked for by the person: still sent with MAIL_DELIVERY=essential. */
@EssentialMail()
@Injectable()
export class ResetPasswordMail extends AccountLinkMail {
  protected readonly kind = 'resetPassword';
}

/** A reset link for an account without a password: an invitation. */
@EssentialMail()
@Injectable()
export class InvitationMail extends AccountLinkMail {
  protected readonly kind = 'invitation';
}

/** Asked for by the person (their own address): essential. */
@EssentialMail()
@Injectable()
export class VerifyEmailMail extends AccountLinkMail {
  protected readonly kind = 'verifyEmail';
}

/** Asked for by the person: essential. */
@EssentialMail()
@Injectable()
export class MagicLinkMail extends AccountLinkMail {
  protected readonly kind = 'magicLink';
}

/** What happened to the account, as the security alert mail tells it. */
export type SecurityAlertKind =
  | 'newSignIn'
  | 'passwordChanged'
  | 'passwordBreached'
  | 'mfaEnabled'
  | 'mfaDisabled'
  | 'passkeyAdded'
  | 'passkeyRemoved';

export interface SecurityAlert {
  kind: SecurityAlertKind;
  name: string;
  /** The message's arguments: `ip`, `device`, the passkey's `name`. */
  args: Record<string, string>;
}

/**
 * A change to the account's security, told to its owner (template
 * `account-security-alert`): a new sign-in, a password changed or found in
 * a breach, two-factor on or off, a passkey added or removed. Essential:
 * the owner must hear of a change they didn't make.
 */
@EssentialMail()
@Injectable()
export class SecurityAlertMail implements Mailable<SecurityAlert> {
  constructor(
    private readonly i18n: I18nService,
    @Inject(accountConfig.KEY)
    private readonly config: Pick<
      ConfigType<typeof accountConfig>,
      'serviceName'
    >,
  ) {}

  render({ kind, name, args }: SecurityAlert, { locale }: MailRenderContext) {
    const app = this.config.serviceName;
    const text = (key: string, values: Record<string, unknown> = {}) =>
      this.i18n.translate(`account.mail.${key}`, { locale, args: values });
    const title = text(`${kind}.subject`, { app });
    return {
      subject: title,
      template: 'account-security-alert',
      context: {
        title,
        greeting: text('greeting', { name }),
        body: text(`${kind}.body`, { ...args, app }),
        footer: text('securityFooter', { app }),
      },
    };
  }
}
