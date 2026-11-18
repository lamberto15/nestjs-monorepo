import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import type { Mailable, MailRenderContext } from '@nestjs/mail';
import { httpConfig } from '../../core/http/http.config.js';
import { EssentialMail } from '../../core/mail/mail.essential.js';

export interface AccountDeletionMailData {
  name: string;
  /** When the account will be deleted, unless cancelled. */
  scheduledFor: Date;
  /** The recipient's time zone (null: UTC). */
  timezone: string | null;
  /** The cancel link's token: WEB_URL/cancel-deletion?token=…, a page that POSTs it to /v1/account/deletion/cancel. */
  token: string;
}

/**
 * "Your account will be deleted on …, unless you cancel", with a link that
 * cancels without signing in. A notice of a destructive action: essential,
 * so it still goes where other mail is withheld.
 */
@EssentialMail()
@Injectable()
export class AccountDeletionMail implements Mailable<AccountDeletionMailData> {
  constructor(
    private readonly i18n: I18nService,
    @Inject(httpConfig.KEY)
    private readonly http: ConfigType<typeof httpConfig>,
  ) {}

  render(
    { name, scheduledFor, timezone, token }: AccountDeletionMailData,
    { locale }: MailRenderContext,
  ) {
    const text = (key: string, args: Record<string, unknown> = {}) =>
      this.i18n.translate(`personalData.mail.accountDeletion.${key}`, {
        locale,
        args,
      });
    const date = this.i18n.formatDate(scheduledFor, {
      locale,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: timezone ?? 'UTC',
    });
    return {
      subject: text('subject'),
      template: 'account-deletion',
      context: {
        greeting: text('greeting', { name }),
        body: text('body', { date }),
        action: text('action'),
        cancelUrl: `${this.http.webUrl}/cancel-deletion?token=${encodeURIComponent(token)}`,
        note: text('note'),
      },
    };
  }
}
