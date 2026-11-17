import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';
import {
  choice,
  optional,
  secret,
  withDefault,
} from '../config/env.helpers.js';

export const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  /**
   * How mail leaves: `file` (.eml files in MAIL_DIRECTORY, development),
   * `log` (printed), `smtp` (SMTP_URL), `resend`, `postmark`, `sendgrid`
   * (MAIL_API_KEY), `ses` (AWS_* credentials), or `memory` (tests).
   */
  MAIL_TRANSPORT: choice(
    ['file', 'log', 'smtp', 'resend', 'postmark', 'sendgrid', 'ses', 'memory'],
    'file',
  ),
  /** The sender of every mail. */
  MAIL_FROM: withDefault('My API <no-reply@example.com>'),
  /** Where the `file` transport writes the .eml files. */
  MAIL_DIRECTORY: withDefault('.data/mail'),
  /** smtp://user:password@smtp.example.com:587 (STARTTLS) or smtps://…:465. */
  SMTP_URL: secret(optional()),
  /** The API key or token of the HTTP provider MAIL_TRANSPORT names. */
  MAIL_API_KEY: secret(optional()),
  /** SES's endpoint: unset for AWS; http://localhost:4566 for a local emulator. */
  SES_ENDPOINT: optional(),
  /** AWS region for SES. */
  AWS_REGION: optional(),
  /** AWS access key for SES; unset, the AWS SDK's own credential lookup applies. */
  AWS_ACCESS_KEY_ID: optional(),
  AWS_SECRET_ACCESS_KEY: secret(optional()),
  AWS_SESSION_TOKEN: secret(optional()),
});

export const mailConfig = registerAs('mail', () => {
  const env = readEnv(schema);
  const credentials =
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          ...(env.AWS_SESSION_TOKEN && { sessionToken: env.AWS_SESSION_TOKEN }),
        }
      : undefined;
  return {
    transport: env.MAIL_TRANSPORT,
    from: env.MAIL_FROM,
    directory: env.MAIL_DIRECTORY,
    smtpUrl: env.SMTP_URL,
    apiKey: env.MAIL_API_KEY,
    ses: {
      region: env.AWS_REGION,
      endpoint: env.SES_ENDPOINT,
      credentials,
    },
    // Development reads the template files for every mail, so edits show without a restart.
    cacheTemplates: env.NODE_ENV === 'production',
  };
});

export type MailSettings = ReturnType<typeof mailConfig>;
