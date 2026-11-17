import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import type { Mailable, MailRenderContext } from '@nestjs/mail';
import { invitationsConfig } from './invitations.config.js';

export interface TenantInvitation {
  /** Who invited, as the audit log names them. */
  inviter: string;
  tenant: string;
  url: string;
  expiresAt: Date;
}

/**
 * The link that lets an address join a tenant. The same mail whether or not
 * the address has an account: it says nothing of either.
 */
@Injectable()
export class TenantInvitationMail implements Mailable<TenantInvitation> {
  constructor(
    private readonly i18n: I18nService,
    @Inject(invitationsConfig.KEY)
    private readonly config: Pick<
      ConfigType<typeof invitationsConfig>,
      'serviceName'
    >,
  ) {}

  render(
    { inviter, tenant, url, expiresAt }: TenantInvitation,
    { locale }: MailRenderContext,
  ) {
    const app = this.config.serviceName;
    const text = (key: string, args: Record<string, unknown> = {}) =>
      this.i18n.translate(`invitations.mail.${key}`, {
        locale,
        args: { app, inviter, tenant, ...args },
      });
    return {
      subject: text('subject'),
      template: 'tenant-invitation',
      context: {
        url,
        greeting: text('greeting'),
        intro: text('intro'),
        action: text('action'),
        note: text('note'),
        expires: text('expires', {
          expiresAt: this.i18n.formatDate(expiresAt, {
            locale,
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'UTC',
            timeZoneName: 'short',
          }),
        }),
      },
    };
  }
}
