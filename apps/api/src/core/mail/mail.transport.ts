import {
  FileMailTransport,
  InMemoryMailTransport,
  LogMailTransport,
  type MailTransport,
  PostmarkTransport,
  ResendTransport,
  SendGridTransport,
  SesTransport,
  SmtpTransport,
} from '@nestjs/mail';
import type { MailSettings } from './mail.config.js';

/**
 * The transport MAIL_TRANSPORT names. Built at startup: a missing SMTP_URL or
 * MAIL_API_KEY stops the app there, not at the first mail.
 */
export function mailTransport(config: MailSettings): MailTransport {
  const required = (name: 'smtpUrl' | 'apiKey') => {
    const value = config[name];
    if (!value) {
      const variable = name === 'smtpUrl' ? 'SMTP_URL' : 'MAIL_API_KEY';
      throw new Error(
        `${variable} is required with MAIL_TRANSPORT=${config.transport}`,
      );
    }
    return value;
  };
  switch (config.transport) {
    case 'file':
      return new FileMailTransport({ directory: config.directory });
    case 'log':
      return new LogMailTransport();
    case 'smtp':
      return new SmtpTransport({ url: required('smtpUrl'), pool: true });
    case 'resend':
      return new ResendTransport({ apiKey: required('apiKey') });
    case 'postmark':
      return new PostmarkTransport({ serverToken: required('apiKey') });
    case 'sendgrid':
      return new SendGridTransport({ apiKey: required('apiKey') });
    case 'ses':
      return new SesTransport(config.ses);
    case 'memory':
      return new InMemoryMailTransport();
  }
}
