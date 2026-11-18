import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import type { Mailable, MailRenderContext } from '@nestjs/mail';
import { reportsConfig } from './reports.config.js';

/** A report's file is ready. */
export interface ReportReadyMailData {
  report: string;
  /** The signed download link. */
  url: string;
  expiresAt: Date;
  rows: number;
  /** The report's time zone: the expiry is shown in it. */
  timezone: string;
}

/** A report's export failed. */
export interface ReportFailedMailData {
  report: string;
}

type Config = Pick<ConfigType<typeof reportsConfig>, 'serviceName'>;

const texts =
  (
    i18n: I18nService,
    locale: string | undefined,
    args: Record<string, unknown>,
  ) =>
  (key: string, more: Record<string, unknown> = {}) =>
    i18n.translate(`reports.mail.${key}`, {
      locale,
      args: { ...args, ...more },
    });

/** "Your report is ready: download it until …", in the owner's language. */
@Injectable()
export class ReportReadyMail implements Mailable<ReportReadyMailData> {
  constructor(
    private readonly i18n: I18nService,
    @Inject(reportsConfig.KEY) private readonly config: Config,
  ) {}

  render(
    { report, url, expiresAt, rows, timezone }: ReportReadyMailData,
    { locale }: MailRenderContext,
  ) {
    const t = texts(this.i18n, locale, {
      report,
      app: this.config.serviceName,
    });
    return {
      subject: t('ready.subject'),
      template: 'report-ready',
      context: {
        url,
        greeting: t('greeting'),
        intro: t('ready.intro', { rows }),
        action: t('ready.action'),
        expires: t('ready.expires', {
          expiresAt: this.i18n.formatDate(expiresAt, {
            locale,
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: timezone,
            timeZoneName: 'short',
          }),
        }),
        why: t('why'),
      },
    };
  }
}

/** "Your report could not be made this time." */
@Injectable()
export class ReportFailedMail implements Mailable<ReportFailedMailData> {
  constructor(
    private readonly i18n: I18nService,
    @Inject(reportsConfig.KEY) private readonly config: Config,
  ) {}

  render({ report }: ReportFailedMailData, { locale }: MailRenderContext) {
    const t = texts(this.i18n, locale, {
      report,
      app: this.config.serviceName,
    });
    return {
      subject: t('failed.subject'),
      template: 'report-failed',
      context: {
        greeting: t('greeting'),
        intro: t('failed.intro'),
        why: t('why'),
      },
    };
  }
}
