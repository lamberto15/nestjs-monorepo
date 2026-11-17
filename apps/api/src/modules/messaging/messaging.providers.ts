import type { Provider } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import {
  getHttpClientToken,
  type HttpClient,
  HttpClientModule,
  type HttpRetryOptions,
} from '@nestjs/http-client';
import { httpConfig } from '../../core/http/http.config.js';
import { messagingConfig } from './messaging.config.js';
import { MemoryPushProvider } from './providers/memory-push.provider.js';
import { MemorySmsProvider } from './providers/memory-sms.provider.js';
import { ApnsPushProvider } from './providers/apns-push.provider.js';
import { CompositePushProvider } from './providers/push-composite.provider.js';
import { FcmPushProvider } from './providers/fcm-push.provider.js';
import { PUSH_PROVIDER, type PushProvider } from './providers/push-provider.js';
import { SMS_PROVIDER, type SmsProvider } from './providers/sms-provider.js';
import { TwilioSmsProvider } from './providers/twilio-sms.provider.js';

type Config = ConfigType<typeof messagingConfig>;

/** The @nestjs/http-client clients of the providers. */
export const TWILIO_HTTP = 'twilio';
export const FCM_HTTP = 'fcm';
export const FCM_TOKEN_HTTP = 'fcm-token';

/** The token URL split for @nestjs/http-client: its origin, and the path to post to. */
export const tokenEndpoint = (url: string) => {
  const parsed = new URL(url);
  return { baseUrl: parsed.origin, path: parsed.pathname };
};

/**
 * Twilio's and FCM's clients: a 10 s limit per attempt. A send is never
 * retried blindly (a POST is not, by default): the queue retries a transient
 * failure with its backoff, and Twilio's idempotency token dedupes it. The one
 * retry here is a 429, a request the provider did not take, which waits out
 * its `Retry-After` (up to 5 s; a longer one goes to the queue). The token
 * exchange has no side effect: it may be retried on any transient failure.
 * APNs is not here: it needs HTTP/2 (apns-push.provider.ts).
 */
export const messagingClients = () => {
  const rateLimited: HttpRetryOptions = {
    attempts: 2,
    methods: ['POST'],
    statusCodes: [429],
    backoff: { delay: '1s', maxDelay: '5s' },
  };
  const register = (
    name: string,
    base: (config: Config) => string,
    retry: HttpRetryOptions,
  ) =>
    HttpClientModule.registerAsync({
      name,
      imports: [ConfigModule.forFeature(messagingConfig)],
      inject: [messagingConfig.KEY],
      useFactory: (config: Config) => ({
        baseUrl: base(config),
        timeout: '10s',
        retry,
      }),
    });
  return [
    register(TWILIO_HTTP, (config) => config.sms.twilio.apiUrl, rateLimited),
    register(FCM_HTTP, (config) => config.push.fcm.apiUrl, rateLimited),
    register(
      FCM_TOKEN_HTTP,
      (config) => tokenEndpoint(config.push.fcm.tokenUrl).baseUrl,
      { attempts: 3, methods: ['POST'] },
    ),
  ];
};

const missing = (provider: string, names: string[]) =>
  new Error(`${provider} needs ${names.join(', ')}.`);

/**
 * The SMS provider SMS_PROVIDER names, or null while `off` (the default:
 * nothing leaves, the SMS channel is not offered). A configured provider with
 * a missing credential stops the app at start rather than failing every send.
 */
export const smsProvider: Provider = {
  provide: SMS_PROVIDER,
  inject: [
    messagingConfig.KEY,
    httpConfig.KEY,
    getHttpClientToken(TWILIO_HTTP),
  ],
  useFactory: (
    config: Config,
    http: ConfigType<typeof httpConfig>,
    client: HttpClient,
  ): SmsProvider | null => {
    switch (config.sms.provider) {
      case 'memory':
        return new MemorySmsProvider();
      case 'twilio': {
        const { accountSid, authToken, from, webhookUrl } = config.sms.twilio;
        if (!accountSid || !authToken || !from) {
          throw missing('SMS_PROVIDER=twilio', [
            'TWILIO_ACCOUNT_SID',
            'TWILIO_AUTH_TOKEN',
            'TWILIO_FROM',
          ]);
        }
        return new TwilioSmsProvider(
          {
            accountSid,
            authToken,
            from,
            webhookUrl: webhookUrl ?? `${http.appUrl}/v1/webhooks/sms/twilio`,
          },
          client,
        );
      }
      default:
        return null;
    }
  },
};

/** A PEM from an environment variable: `\n` written as two characters become newlines. */
const pem = (value: string) => value.replace(/\\n/g, '\n');

/**
 * The push providers PUSH_PROVIDER names (several serve several platforms),
 * or null while `off`. A configured provider with a missing credential stops
 * the app at start.
 */
export const pushProvider: Provider = {
  provide: PUSH_PROVIDER,
  inject: [
    messagingConfig.KEY,
    getHttpClientToken(FCM_HTTP),
    getHttpClientToken(FCM_TOKEN_HTTP),
  ],
  useFactory: (
    config: Config,
    fcmHttp: HttpClient,
    tokenHttp: HttpClient,
  ): PushProvider | null => {
    const providers = config.push.providers.map((name): PushProvider => {
      switch (name) {
        case 'memory':
          return new MemoryPushProvider();
        case 'apns': {
          const { keyId, privateKey, teamId, bundleId, apiUrl } =
            config.push.apns;
          if (!keyId || !privateKey || !teamId || !bundleId) {
            throw missing('PUSH_PROVIDER=apns', [
              'APNS_KEY_ID',
              'APNS_PRIVATE_KEY',
              'APNS_TEAM_ID',
              'APNS_BUNDLE_ID',
            ]);
          }
          return new ApnsPushProvider({
            keyId,
            privateKey: pem(privateKey),
            teamId,
            bundleId,
            apiUrl,
          });
        }
        case 'fcm': {
          const { projectId, clientEmail, privateKey, tokenUrl } =
            config.push.fcm;
          if (!projectId || !clientEmail || !privateKey) {
            throw missing('PUSH_PROVIDER=fcm', [
              'FCM_PROJECT_ID',
              'FCM_CLIENT_EMAIL',
              'FCM_PRIVATE_KEY',
            ]);
          }
          return new FcmPushProvider(
            {
              projectId,
              clientEmail,
              privateKey: pem(privateKey),
              tokenUrl,
              tokenPath: tokenEndpoint(tokenUrl).path,
            },
            fcmHttp,
            tokenHttp,
          );
        }
      }
    });
    if (providers.length === 0) return null;
    return providers.length === 1
      ? providers[0]!
      : new CompositePushProvider(providers);
  },
};
