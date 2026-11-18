import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import type { Mailable, MailRenderContext } from '@nestjs/mail';
import { sharesConfig } from './shares.config.js';

export interface ShareCode {
  code: string;
  /** Minutes the code works. */
  minutes: number;
}

/**
 * The code that opens a link shared with one address: it proves the
 * mailbox, each time the link is opened. It names neither the record nor
 * who shared it: whoever holds the mailbox and the link already knows, and
 * a mail that went astray tells nothing.
 */
@Injectable()
export class ShareCodeMail implements Mailable<ShareCode> {
  constructor(
    private readonly i18n: I18nService,
    @Inject(sharesConfig.KEY)
    private readonly config: Pick<
      ConfigType<typeof sharesConfig>,
      'serviceName'
    >,
  ) {}

  render({ code, minutes }: ShareCode, { locale }: MailRenderContext) {
    const app = this.config.serviceName;
    const text = (key: string, args: Record<string, unknown> = {}) =>
      this.i18n.translate(`shares.mail.${key}`, {
        locale,
        args: { app, minutes, ...args },
      });
    return {
      subject: text('subject'),
      template: 'share-code',
      context: {
        code,
        intro: text('intro'),
        expires: text('expires'),
      },
    };
  }
}
