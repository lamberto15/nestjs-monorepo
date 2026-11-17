import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { abortable } from '../../core/queues/abortable.js';
import { clip } from './messaging.policy.js';
import { MESSAGING, type PushJob, type SmsJob } from './messaging.queue.js';
import { MessagingService } from './messaging.service.js';
import { PUSH_PROVIDER, type PushProvider } from './providers/push-provider.js';
import { SMS_PROVIDER, type SmsProvider } from './providers/sms-provider.js';

/** What a message needs to be queued for one user. */
export interface Outgoing {
  /** The tenant whose caps and kill switch apply. */
  tenantId: string;
  userId: string;
  /** Stable per message: a retried delivery queues it once. */
  messageId: string;
  /** Quiet hours: queued to leave when they end. */
  sendAt?: Date | null;
}

const delayOf = (sendAt?: Date | null) =>
  sendAt ? { delay: Math.max(0, sendAt.getTime() - Date.now()) } : {};

/**
 * What the notification delivery calls to text or push a person: it only
 * queues (before any transaction: the add waits on Redis and must not hold a
 * connection); the worker applies the kill switch and the toll-fraud caps and
 * sends (messaging.processor.ts), so a slow or failing provider never holds
 * the delivery. Nothing is queued while the provider is `off` or the user has
 * no verified number or device.
 */
@Injectable()
export class MessagingSender {
  constructor(
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider | null,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider | null,
    @InjectQueue(MESSAGING) private readonly queue: Queue,
    private readonly messaging: MessagingService,
  ) {}

  /** Whether SMS is offered at all (SMS_PROVIDER is not `off`). */
  get smsEnabled() {
    return this.sms !== null;
  }

  /** Whether mobile push is offered at all (PUSH_PROVIDER is not `off`). */
  get pushEnabled() {
    return this.push !== null;
  }

  /** Texts a title and body to the user's verified number that has not opted out. */
  async text(
    message: Outgoing & { title: string; body: string },
    signal?: AbortSignal,
  ) {
    if (!this.sms || !(await this.messaging.hasSendablePhone(message.userId))) {
      return false;
    }
    const job: SmsJob = {
      kind: 'sms',
      tenantId: message.tenantId,
      userId: message.userId,
      notificationId: message.messageId,
      text: clip(`${message.title}: ${message.body}`, 1600),
    };
    await abortable(
      signal,
      this.queue.add('sms', job, {
        jobId: `sms-${message.messageId}`,
        ...delayOf(message.sendAt),
      }),
    );
    return true;
  }

  /** Pushes to each of the user's registered mobile devices (one job each, with its own retries). */
  async pushToDevices(
    message: Outgoing & { title: string; body: string; link: string | null },
    signal?: AbortSignal,
  ) {
    if (!this.push) return 0;
    const ids = await this.messaging.deviceIdsOf(message.userId);
    for (const deviceId of ids) {
      const job: PushJob = {
        kind: 'push',
        tenantId: message.tenantId,
        deviceId,
        notificationId: message.messageId,
        title: message.title,
        body: message.body,
        link: message.link,
      };
      await abortable(
        signal,
        this.queue.add('push', job, {
          jobId: `push-${message.messageId}-${deviceId}`,
          ...delayOf(message.sendAt),
        }),
      );
    }
    return ids.length;
  }
}
