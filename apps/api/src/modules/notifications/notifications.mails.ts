import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import type { Mailable, MailRenderContext } from '@nestjs/mail';
import { httpConfig } from '../../core/http/http.config.js';
import { observabilityConfig } from '../../core/observability/observability.config.js';
import { notificationsConfig } from './notifications.config.js';
import {
  UnsubscribeLinks,
  unsubscribeHeaders,
} from './notifications.unsubscribe.js';

/** One notification, mailed at once. */
export interface NotificationMailData {
  name: string;
  title: string;
  body: string;
  /** Where to go about it: a path of the web app, or null. */
  link: string | null;
  /**
   * The unsubscribe token (UnsubscribeLinks): the mail then carries the
   * one-click headers and a footer link. Null for a mandatory type, which the
   * person can't switch off.
   */
  unsubscribe: string | null;
}

/** Several notifications, bundled: an hourly or daily digest. */
export interface NotificationDigestData {
  name: string;
  items: { title: string; body: string; link: string | null; at: Date }[];
  /** How many the digest stands for (the items, plus `more` not listed). */
  count: number;
  more: number;
  /** The recipient's time zone (null: the deployment's): times are shown in it. */
  timezone: string | null;
  /** The unsubscribe token for the digest (null when it lists only mandatory types). */
  unsubscribe: string | null;
}

/** What the two mails share: the app's name and address, the recipient's language. */
@Injectable() // Nest reads the subclasses' dependencies from here.
abstract class NotificationMailable {
  constructor(
    protected readonly i18n: I18nService,
    protected readonly links: UnsubscribeLinks,
    @Inject(httpConfig.KEY)
    protected readonly http: Pick<ConfigType<typeof httpConfig>, 'appUrl'>,
    @Inject(observabilityConfig.KEY)
    protected readonly app: Pick<
      ConfigType<typeof observabilityConfig>,
      'serviceName'
    >,
    @Inject(notificationsConfig.KEY)
    protected readonly config: Pick<
      ConfigType<typeof notificationsConfig>,
      'timezone' | 'unsubscribeMailto'
    >,
  ) {}

  protected text(
    locale: string | undefined,
    key: string,
    args: Record<string, unknown> = {},
  ) {
    return this.i18n.translate(`notificationCenter.mail.${key}`, {
      locale,
      args: { app: this.app.serviceName, ...args },
    });
  }

  /** RFC 8058 headers and the footer link, from an unsubscribe token (none: neither). */
  protected unsubscribe(token: string | null) {
    if (!token) return { headers: {}, unsubscribeUrl: null };
    return {
      headers: unsubscribeHeaders(
        this.links.url(token),
        this.config.unsubscribeMailto,
      ),
      unsubscribeUrl: this.links.pageUrl(token),
    };
  }

  /** A notification's link as an absolute URL of the web app. */
  protected url(link: string | null) {
    return link ? `${this.http.appUrl}${link}` : null;
  }
}

/** A notification sent at once (`email: 'immediate'`): its title is the subject. */
@Injectable()
export class NotificationMail
  extends NotificationMailable
  implements Mailable<NotificationMailData>
{
  render(
    { name, title, body, link, unsubscribe }: NotificationMailData,
    { locale }: MailRenderContext,
  ) {
    const { headers, unsubscribeUrl } = this.unsubscribe(unsubscribe);
    return {
      headers,
      subject: this.text(locale, 'subject', { title }),
      template: 'notification',
      context: {
        greeting: this.text(locale, 'greeting', { name }),
        title,
        body,
        url: this.url(link),
        open: this.text(locale, 'open'),
        footer: this.text(locale, 'footer'),
        unsubscribeUrl,
        unsubscribe: this.text(locale, 'unsubscribe'),
      },
    };
  }
}

/** The notifications of an hour or a day in one mail (`email: 'hourly' | 'daily'`). */
@Injectable()
export class NotificationDigestMail
  extends NotificationMailable
  implements Mailable<NotificationDigestData>
{
  render(
    { name, items, count, more, timezone, unsubscribe }: NotificationDigestData,
    { locale }: MailRenderContext,
  ) {
    const { headers, unsubscribeUrl } = this.unsubscribe(unsubscribe);
    const timeZone = timezone ?? this.config.timezone;
    return {
      headers,
      subject: this.text(locale, 'digestSubject', { count }),
      template: 'notification-digest',
      context: {
        greeting: this.text(locale, 'greeting', { name }),
        intro: this.text(locale, 'digestIntro', { count }),
        more: more > 0 ? this.text(locale, 'digestMore', { more }) : null,
        footer: this.text(locale, 'digestFooter'),
        unsubscribeUrl,
        unsubscribe: this.text(locale, 'unsubscribe'),
        items: items.map((item) => ({
          title: item.title,
          body: item.body,
          url: this.url(item.link),
          // Per item: the template engine's each-blocks see their item only.
          open: this.text(locale, 'open'),
          at: this.i18n.formatDate(item.at, {
            locale,
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone,
          }),
        })),
      },
    };
  }
}
