import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../../core/config/env.js';
import {
  flag,
  integer,
  list,
  optional,
  secret,
} from '../../core/config/env.helpers.js';

export const schema = z.object({
  /**
   * The SNS topics whose notifications `POST /v1/webhooks/mail/ses` accepts
   * (comma-separated ARNs): the ones SES publishes bounces and complaints to.
   * Empty: every notification is refused (403), so the route is inert.
   */
  SES_SNS_TOPIC_ARNS: list(),
  /** Refuse SNS messages signed with SignatureVersion 1 (SHA1): set the topic's attribute to 2 first. */
  SES_SNS_REQUIRE_SIGNATURE_V2: flag('off'),
  /**
   * Postmark's webhooks (`POST /v1/webhooks/mail/postmark`): the shared secret,
   * sent as the Basic Auth password of the webhook URL or in the
   * `X-Postmark-Webhook-Secret` header (Postmark does not sign). Unset: refused (403).
   */
  POSTMARK_WEBHOOK_SECRET: secret(optional()),
  /**
   * Resend's signed webhooks (`POST /v1/webhooks/mail/resend`): the endpoint's
   * signing secret (`whsec_…`), verified the Svix way. Unset: refused (403).
   */
  RESEND_WEBHOOK_SECRET: secret(optional()),
  /**
   * SendGrid's signed Event Webhook (`POST /v1/webhooks/mail/sendgrid`): the
   * verification key the console shows (base64 SPKI). Public, not a secret.
   * Unset: refused (403).
   */
  SENDGRID_WEBHOOK_PUBLIC_KEY: optional(),
  /** Transient (soft) bounces within MAIL_SOFT_BOUNCE_WINDOW_HOURS before an address is suppressed. */
  MAIL_SOFT_BOUNCE_THRESHOLD: integer(3, { min: 1, max: 50 }),
  /** Soft bounces count when the previous one is at most this many hours old; older, the count starts over. */
  MAIL_SOFT_BOUNCE_WINDOW_HOURS: integer(24, { min: 1 }),
  /** How long a soft-bounce suppression lasts; then the address is only watched again (a full mailbox empties). */
  MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS: integer(72, { min: 1 }),
  /** Bounce, complaint and delivery events (the trail behind the suppression list) older than this many days are deleted every night. */
  MAIL_EVENTS_RETENTION_DAYS: integer(90, { min: 1 }),
});

export const deliverabilityConfig = registerAs('deliverability', () => {
  const env = readEnv(schema);
  return {
    sesTopicArns: env.SES_SNS_TOPIC_ARNS,
    sesRequireSignatureV2: env.SES_SNS_REQUIRE_SIGNATURE_V2,
    postmarkSecret: env.POSTMARK_WEBHOOK_SECRET,
    resendSecret: env.RESEND_WEBHOOK_SECRET,
    sendgridPublicKey: env.SENDGRID_WEBHOOK_PUBLIC_KEY,
    softBounce: {
      threshold: env.MAIL_SOFT_BOUNCE_THRESHOLD,
      windowHours: env.MAIL_SOFT_BOUNCE_WINDOW_HOURS,
      suppressionHours: env.MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS,
    },
    eventsRetentionDays: env.MAIL_EVENTS_RETENTION_DAYS,
  };
});
