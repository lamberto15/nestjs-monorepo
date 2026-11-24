import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Counter } from '@opentelemetry/api';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { PostmarkIntake } from './intake/postmark.intake.js';
import { ResendIntake } from './intake/resend.intake.js';
import { SendGridIntake } from './intake/sendgrid.intake.js';
import { SesIntake } from './intake/ses.intake.js';
import {
  type IntakeRequest,
  MAIL_EVENTS,
  type MailEventIntake,
  type MailEventsJob,
} from './mail-event.types.js';

/** What the route answers. */
export interface MailEventsReceipt {
  received: true;
  /** `events` (queued), `handshake` (the provider's subscription confirmed) or `ignored`. */
  kind: 'events' | 'handshake' | 'ignored';
  /** How many events were queued (`events`), 0 otherwise. */
  events: number;
}

/**
 * Receives a provider's notification: the intake authenticates it and turns
 * it into events, which go to the `mail-events` queue (job id: the provider's
 * message id, so a redelivery that arrives while the first job is kept is
 * dropped here; the one that arrives later is a no-op in the processor). The
 * request does nothing else. A provider is one more intake class in the
 * constructor, reached at `POST /v1/webhooks/mail/<name>`.
 */
@Injectable()
export class MailEventsService {
  private readonly logger = new Logger('MailEvents');
  private readonly intakes: Map<string, MailEventIntake>;
  private readonly received: Counter;

  constructor(
    ses: SesIntake,
    postmark: PostmarkIntake,
    resend: ResendIntake,
    sendgrid: SendGridIntake,
    @InjectQueue(MAIL_EVENTS) private readonly queue: Queue<MailEventsJob>,
    metrics: MetricsService,
  ) {
    this.intakes = new Map(
      [ses, postmark, resend, sendgrid].map((intake) => [intake.name, intake]),
    );
    this.received = metrics.counter('mail_events', {
      description:
        'Bounce, complaint and delivery events mail providers reported, by provider and type (counted when received, before the queue).',
    });
  }

  async receive(
    provider: string,
    request: IntakeRequest,
  ): Promise<MailEventsReceipt> {
    const intake = this.intakes.get(provider);
    if (!intake) {
      throw new NotFoundException(`No mail provider named "${provider}".`);
    }
    const result = await intake.receive(request);
    if (result.kind !== 'events') {
      this.logger.log(`Mail notification ${result.kind}`, {
        provider,
        detail: result.detail,
      });
      return { received: true, kind: result.kind, events: 0 };
    }
    for (const event of result.events) {
      this.received.add(1, { provider, type: event.type });
    }
    await this.queue.add(
      provider,
      { provider, id: result.id, events: result.events },
      // A message id is unique per notification and safe in a job id (no `:`).
      { jobId: `${provider}-${result.id.replace(/[^A-Za-z0-9_-]/g, '_')}` },
    );
    return { received: true, kind: 'events', events: result.events.length };
  }
}
