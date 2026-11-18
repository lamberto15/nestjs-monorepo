import { Agent } from 'node:https';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import * as webPush from 'web-push';
import {
  destinationProblem,
  guardedLookup,
  UnsafeDestinationError,
} from '../../core/http/safe-fetch.js';
import { Secrets } from '../../core/secrets/secrets.service.js';
import { notificationsConfig } from './notifications.config.js';

/** The queue web push messages go through: one job per device. */
export const PUSH_QUEUE = 'push';

/**
 * What a push job carries: the device, the person it was rendered for, and
 * the message (what the service worker shows). A browser can move to another
 * account while a push waits out quiet hours: it is sent only while the
 * device is still `userId`'s.
 */
export interface PushJob {
  deviceId: string;
  userId: string;
  notificationId: string;
  title: string;
  body: string;
  /** A path of the web app the click opens, or null. */
  link: string | null;
  /** Urgent types ask the push service for prompt delivery. */
  urgent: boolean;
}

/** The longest body sent: a push payload is limited (about 4 KB, encrypted). */
export const PUSH_BODY_MAX = 500;

/**
 * The push service call, apart so a test can stand in for it. The endpoint
 * is the browser's, so whoever registers a device names it: safeFetch's
 * address rules (core/http) guard it. An IP literal is checked here, a host
 * name at connect time by the agent's `lookup` (web-push's documented
 * `agent` option), so a name that resolves to a private address is refused
 * however DNS answers later. web-push makes one `https.request` and follows
 * no redirect.
 */
@Injectable()
export class WebPushTransport {
  private readonly agent = new Agent({
    keepAlive: true,
    lookup: guardedLookup(),
  });

  send(
    subscription: webPush.PushSubscription,
    payload: string,
    vapidDetails: webPush.VapidDetails,
    urgent: boolean,
  ) {
    const problem = destinationProblem(new URL(subscription.endpoint));
    if (problem) {
      return Promise.reject(new UnsafeDestinationError(problem));
    }
    return webPush.sendNotification(subscription, payload, {
      vapidDetails,
      urgency: urgent ? 'high' : 'normal',
      timeout: 10_000,
      agent: this.agent,
    });
  }
}

/** Whether a push service's refusal means the browser is gone for good (unsubscribed, expired). */
export const isGone = (error: unknown) =>
  error instanceof webPush.WebPushError &&
  (error.statusCode === 404 || error.statusCode === 410);

/** Whether the endpoint is one the address rules refuse: retrying won't change that. */
export const isRefused = (error: unknown) =>
  error instanceof UnsafeDestinationError;

/**
 * Web push (VAPID): the keys and the sending. The keys come from
 * WEB_PUSH_PUBLIC_KEY and WEB_PUSH_PRIVATE_KEY, or are made once and kept in
 * the database (core/secrets) so every instance shares them; the contact
 * (`WEB_PUSH_SUBJECT`) is what switches web push on.
 */
@Injectable()
export class WebPush {
  private keys?: Promise<{ publicKey: string; privateKey: string }>;

  constructor(
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
    private readonly secrets: Secrets,
    private readonly transport: WebPushTransport,
  ) {}

  get enabled() {
    return this.config.webPush !== undefined;
  }

  private vapidKeys() {
    this.keys ??= (async () => {
      const given = this.config.webPush?.keys;
      if (given) return given;
      const stored = await this.secrets.loadOrCreate(
        'web-push-vapid-keys',
        () => JSON.stringify(webPush.generateVAPIDKeys()),
      );
      return JSON.parse(stored) as { publicKey: string; privateKey: string };
    })();
    return this.keys;
  }

  /** The public key a browser subscribes with; null while web push is off. */
  async publicKey() {
    return this.enabled ? (await this.vapidKeys()).publicKey : null;
  }

  /** Sends one message to one browser. A refusal throws; `isGone()` tells a dead device. */
  async send(
    subscription: webPush.PushSubscription,
    message: Pick<PushJob, 'title' | 'body' | 'link' | 'urgent'>,
  ) {
    if (!this.config.webPush) {
      throw new Error('Web push is off: WEB_PUSH_SUBJECT is not set.');
    }
    const keys = await this.vapidKeys();
    await this.transport.send(
      subscription,
      JSON.stringify({
        title: message.title,
        body: message.body.slice(0, PUSH_BODY_MAX),
        link: message.link,
      }),
      { subject: this.config.webPush.subject, ...keys },
      message.urgent,
    );
  }
}
