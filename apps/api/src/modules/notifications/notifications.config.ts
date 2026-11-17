import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../../core/config/env.js';
import {
  integer,
  optional,
  secret,
  withDefault,
} from '../../core/config/env.helpers.js';

export const schema = z.object({
  /** Outside production, `POST /notifications/test` sends the caller a test notification (to try the bell, the live count and the mail). */
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  /** Read notifications older than this many days are deleted every night. */
  NOTIFICATIONS_RETENTION_DAYS: integer(90, { min: 1 }),
  /** Any notification older than this many days is deleted every night, read or not. */
  NOTIFICATIONS_MAX_AGE_DAYS: integer(365, { min: 1 }),
  /** The hour (0-23, on each user's clock) the daily digest mail is sent. */
  NOTIFICATIONS_DIGEST_HOUR: integer(8, { min: 0, max: 23 }),
  /** The time zone (IANA) of users who chose none: digests and quiet hours follow its clock. */
  NOTIFICATIONS_TIMEZONE: withDefault('UTC'),
  /**
   * A mailbox that also receives unsubscribe requests (RFC 8058 `List-Unsubscribe`
   * `mailto:` form), besides the https link. Unset: the link only.
   */
  MAIL_UNSUBSCRIBE_MAILTO: optional(),
  /**
   * Turns web push on: who the push services may contact about it, `mailto:ops@example.com`
   * or an https URL (VAPID subject). Unset: no web push, and no push channel.
   */
  WEB_PUSH_SUBJECT: optional(),
  /** The VAPID public key (`npx web-push generate-vapid-keys`). Unset with the private key: made once and kept in the database. */
  WEB_PUSH_PUBLIC_KEY: optional(),
  /** The VAPID private key; set both or neither. */
  WEB_PUSH_PRIVATE_KEY: secret(optional()),
  /** A browser registered for push but not seen for this many days is forgotten every night. */
  WEB_PUSH_DEVICE_RETENTION_DAYS: integer(270, { min: 1 }),
});

export const notificationsConfig = registerAs('notifications', () => {
  const env = readEnv(schema);
  if (!env.WEB_PUSH_PUBLIC_KEY !== !env.WEB_PUSH_PRIVATE_KEY) {
    throw new Error(
      'WEB_PUSH_PUBLIC_KEY and WEB_PUSH_PRIVATE_KEY go together: set both, or neither to have the keys made once.',
    );
  }
  return {
    testRoute: env.NODE_ENV !== 'production',
    retentionDays: env.NOTIFICATIONS_RETENTION_DAYS,
    maxAgeDays: env.NOTIFICATIONS_MAX_AGE_DAYS,
    digestHour: env.NOTIFICATIONS_DIGEST_HOUR,
    timezone: env.NOTIFICATIONS_TIMEZONE,
    unsubscribeMailto: env.MAIL_UNSUBSCRIBE_MAILTO,
    webPush: env.WEB_PUSH_SUBJECT
      ? {
          subject: env.WEB_PUSH_SUBJECT,
          keys:
            env.WEB_PUSH_PUBLIC_KEY && env.WEB_PUSH_PRIVATE_KEY
              ? {
                  publicKey: env.WEB_PUSH_PUBLIC_KEY,
                  privateKey: env.WEB_PUSH_PRIVATE_KEY,
                }
              : undefined,
        }
      : undefined,
    deviceRetentionDays: env.WEB_PUSH_DEVICE_RETENTION_DAYS,
  };
});
