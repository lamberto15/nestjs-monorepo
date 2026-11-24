import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../../core/config/env.js';
import {
  baseUrl,
  choice,
  integer,
  list,
  optional,
  secret,
} from '../../core/config/env.helpers.js';

export const schema = z.object({
  /** SMS provider: `off`, `twilio`, or `memory` (tests: keeps what it would send). Off until configured: nothing leaves. */
  SMS_PROVIDER: choice(['off', 'twilio', 'memory'], 'off'),
  TWILIO_ACCOUNT_SID: optional(),
  TWILIO_AUTH_TOKEN: secret(optional()),
  /** The sending number (E.164) or a Messaging Service SID (`MG…`). */
  TWILIO_FROM: optional(),
  /** The URL Twilio posts inbound messages to, when it is not APP_URL + the route (a proxy rewrites it): it is part of what Twilio signs. */
  TWILIO_WEBHOOK_URL: optional(),
  /** Twilio's REST API (a stub on loopback in tests). */
  TWILIO_API_URL: baseUrl('https://api.twilio.com'),
  /**
   * Mobile push providers, comma-separated: `off` (default), `apns` (iOS),
   * `fcm` (Android), `memory` (tests). `apns,fcm` serves both platforms; each
   * device goes to the provider of its platform. Browsers' web push is the
   * notifications module's.
   */
  PUSH_PROVIDER: list().pipe(
    z
      .array(z.enum(['off', 'apns', 'fcm', 'memory']))
      .transform((values) => values.filter((value) => value !== 'off')),
  ),
  /** APNs (token-based auth): the .p8 key's id and contents (PEM; `\n` for newlines), the Apple team id, the app's bundle id. */
  APNS_KEY_ID: optional(),
  APNS_PRIVATE_KEY: secret(optional()),
  APNS_TEAM_ID: optional(),
  APNS_BUNDLE_ID: optional(),
  /** APNs' host: production by default; `https://api.sandbox.push.apple.com` for development builds (a stub on loopback in tests). */
  APNS_API_URL: baseUrl('https://api.push.apple.com'),
  /** FCM (HTTP v1): the Firebase project id and the service account's `client_email` and `private_key` (PEM; `\n` for newlines). */
  FCM_PROJECT_ID: optional(),
  FCM_CLIENT_EMAIL: optional(),
  FCM_PRIVATE_KEY: secret(optional()),
  FCM_API_URL: baseUrl('https://fcm.googleapis.com'),
  /** Google's OAuth2 token endpoint (a stub on loopback in tests). */
  FCM_TOKEN_URL: baseUrl('https://oauth2.googleapis.com/token'),
  /**
   * Toll fraud: the destination country-calling-code prefixes SMS may go to
   * (`+1,+44,+49`). Empty: none, so no SMS is sent until the deployment
   * names the countries it serves.
   */
  SMS_ALLOWED_PREFIXES: list(),
  /** SMS a tenant may send per day, whoever the recipients. */
  SMS_DAILY_LIMIT_PER_TENANT: integer(200, { min: 0 }),
  /** SMS a tenant may send per day to one allowed prefix (a premium-rate pump hits one prefix). */
  SMS_DAILY_LIMIT_PER_PREFIX: integer(100, { min: 0 }),
  /** SMS one user may be sent per day (codes included). */
  SMS_DAILY_LIMIT_PER_USER: integer(10, { min: 0 }),
  /** Codes one client IP may have texted per day in a tenant (the route also has its own throttle). */
  SMS_DAILY_LIMIT_PER_IP: integer(20, { min: 0 }),
  /** A tenant's SMS spend cap per UTC month, in minor units of one currency; 0 is no cap. Sending stops at the cap; passing 80 % is logged as an error, once a month; `sms_spend_minor` counts the spend for an alert. */
  SMS_MONTHLY_BUDGET_MINOR: integer(0, { min: 0 }),
  /** The price of one SMS segment per prefix, minor units: `+1=79,+44=120`. */
  SMS_PRICES: list().transform((entries, ctx) => {
    const prices: Record<string, number> = {};
    for (const entry of entries) {
      const [prefix, price] = entry.split('=').map((part) => part.trim());
      if (
        !prefix ||
        !/^\+[1-9]\d{0,5}$/.test(prefix) ||
        !/^\d+$/.test(price ?? '')
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `"${entry}" is not <+prefix>=<minor units>`,
        });
        return z.NEVER;
      }
      prices[prefix] = Number(price);
    }
    return prices;
  }),
  /** The price of one SMS segment to a prefix SMS_PRICES does not list. */
  SMS_PRICE_DEFAULT_MINOR: integer(0, { min: 0 }),
  /** The longest SMS text, in characters; a longer one is cut. */
  SMS_MAX_LENGTH: integer(320, { min: 1, max: 1600 }),
  /** The longest push payload, in bytes; a longer body is cut. */
  PUSH_MAX_PAYLOAD_BYTES: integer(3500, { min: 256, max: 4096 }),
  /** A person's mobile devices that have not been seen for this many days are removed every night. */
  MESSAGING_DEVICE_RETENTION_DAYS: integer(270, { min: 1 }),
});

export const messagingConfig = registerAs('messaging', () => {
  const env = readEnv(schema);
  return {
    sms: {
      provider: env.SMS_PROVIDER,
      twilio: {
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        from: env.TWILIO_FROM,
        webhookUrl: env.TWILIO_WEBHOOK_URL,
        apiUrl: env.TWILIO_API_URL!,
      },
      allowedPrefixes: env.SMS_ALLOWED_PREFIXES,
      dailyLimitPerTenant: env.SMS_DAILY_LIMIT_PER_TENANT,
      dailyLimitPerPrefix: env.SMS_DAILY_LIMIT_PER_PREFIX,
      dailyLimitPerUser: env.SMS_DAILY_LIMIT_PER_USER,
      dailyLimitPerIp: env.SMS_DAILY_LIMIT_PER_IP,
      monthlyBudgetMinor: env.SMS_MONTHLY_BUDGET_MINOR,
      prices: env.SMS_PRICES,
      priceDefaultMinor: env.SMS_PRICE_DEFAULT_MINOR,
      maxLength: env.SMS_MAX_LENGTH,
    },
    push: {
      providers: env.PUSH_PROVIDER,
      apns: {
        keyId: env.APNS_KEY_ID,
        privateKey: env.APNS_PRIVATE_KEY,
        teamId: env.APNS_TEAM_ID,
        bundleId: env.APNS_BUNDLE_ID,
        apiUrl: env.APNS_API_URL!,
      },
      fcm: {
        projectId: env.FCM_PROJECT_ID,
        clientEmail: env.FCM_CLIENT_EMAIL,
        privateKey: env.FCM_PRIVATE_KEY,
        apiUrl: env.FCM_API_URL!,
        tokenUrl: env.FCM_TOKEN_URL!,
      },
      maxPayloadBytes: env.PUSH_MAX_PAYLOAD_BYTES,
    },
    deviceRetentionDays: env.MESSAGING_DEVICE_RETENTION_DAYS,
  };
});
