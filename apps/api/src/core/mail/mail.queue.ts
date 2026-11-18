import { randomUUID } from 'node:crypto';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { ConfigType } from '@nestjs/config';
import {
  type Mailable,
  type MailableRenderOptions,
  type MailAddress,
  MailError,
  Mailer,
} from '@nestjs/mail';
import {
  type DefaultJobOptions,
  type Job,
  type Queue,
  UnrecoverableError,
} from 'bullmq';
import { Counter } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service.js';
import { abortable } from '../queues/abortable.js';
import { DEFAULT_JOB_OPTIONS } from '../queues/queues.js';
import {
  DEFAULT_MAIL_BRAND,
  MailBrand,
  type MailBranding,
  withMailBrand,
} from './mail-brand.js';
import {
  type MailDelivery,
  MailDeliveryPolicy,
  stricterMode,
} from './mail-delivery.js';
import { markedProvider } from './mail.discovery.js';
import { mailConfig } from './mail.config.js';
import { isEssentialMail } from './mail.essential.js';
import {
  type MailSuppression,
  MailSuppressionList,
  normalizeAddress,
  SUPPRESSION_REASONS,
} from './mail-suppression.js';

/** The queue every mail goes through. */
export const MAIL_QUEUE = 'mail';

/**
 * About six hours of retries, so a provider outage doesn't lose the mail
 * (the shared defaults give up after seconds).
 */
export const MAIL_JOB_OPTIONS: DefaultJobOptions = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 10,
  backoff: { type: 'exponential', delay: 30_000 },
};

/** A rendered mail, ready to send: what a job carries. */
export interface QueuedMail {
  from: MailAddress;
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  html?: string;
  text?: string;
  headers: Record<string, string>;
  /** Essential mail still reaches an address that complained (mail-suppression.ts). */
  essential?: boolean;
}

/**
 * Sends mail through a queue: the request renders it (template, language,
 * the tenant's brand) and returns at once; a worker sends it, retrying a provider that is down
 * with backoff. The job id is the mail's idempotency key, so a retry after a
 * crash doesn't send it twice. A refusal that won't change (an unknown
 * address) fails at once.
 *
 * ```ts
 * await this.mailQueue.send(WelcomeMail, { to: user.email, data: user, locale: user.locale });
 * ```
 */
@Injectable()
export class MailQueue {
  private readonly logger = new Logger('MailQueue');

  constructor(
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue<QueuedMail>,
    private readonly mailer: Mailer,
    @Inject(mailConfig.KEY)
    private readonly config: Pick<ConfigType<typeof mailConfig>, 'delivery'>,
    private readonly discovery: DiscoveryService,
    metrics: MetricsService,
  ) {
    this.withheld = new Counter({
      name: 'mail_withheld_total',
      help: 'Mails not queued: the delivery mode or the daily budget kept them, by reason.',
      labelNames: ['reason'] as const,
      registers: [metrics.registry],
    });
    for (const reason of ['policy', 'budget']) {
      this.withheld.labels(reason).inc(0);
    }
  }

  private readonly withheld: Counter<'reason'>;

  async send<M extends Mailable<any>>(
    mail: Type<M>,
    options: MailableRenderOptions<Parameters<M['render']>[0]>,
    {
      jobId = randomUUID(),
      signal,
      essential = false,
    }: {
      /** Your own job id when the call may repeat (a retried handler): the mail goes once. */
      jobId?: string;
      /** Stops waiting for Redis (the add may still land: the job id makes that harmless). */
      signal?: AbortSignal;
      /** Essential for this send (a mandatory notification), besides a class marked `@EssentialMail()`. */
      essential?: boolean;
    } = {},
  ) {
    signal?.throwIfAborted();
    const isEssential = essential || isEssentialMail(mail);
    // The mode and the daily budget, before rendering: a mail storm costs
    // neither renders nor Redis memory.
    const reason = await this.withholdReason(mail, isEssential);
    if (reason) {
      this.withheld.labels(reason).inc();
      this.logger.warn(`Mail withheld (${reason})`, { mail: mail.name });
      return;
    }
    // Cosmetic: a brand that can't be read never keeps a mail back.
    const brand = await this.brand();
    const message = await withMailBrand(brand, () =>
      this.mailer.render(mail, options),
    );
    if (message.attachments.length > 0) {
      throw new Error(
        'Queued mail carries no attachments: store the file and link to it.',
      );
    }
    await abortable(
      signal,
      this.queue.add(
        mail.name,
        {
          from:
            brand.name && !options.from
              ? { ...message.from, name: brand.name }
              : message.from,
          replyTo: [...message.replyTo],
          to: [...message.to],
          cc: [...message.cc],
          bcc: [...message.bcc],
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: { ...message.headers },
          essential: isEssential,
        },
        { jobId },
      ),
    );
  }

  /**
   * Why the mail may not be queued, or null. The environment's MAIL_DELIVERY
   * is the ceiling; the policy (modules/deliverability) can only be
   * stricter. A policy that can't be read leaves the ceiling alone: an
   * outage of the settings must not keep back a sign-in link.
   */
  private async withholdReason(mail: Type<unknown>, essential: boolean) {
    const policy = markedProvider<MailDelivery>(
      this.discovery,
      MailDeliveryPolicy,
    );
    let mode = this.config.delivery;
    try {
      mode = stricterMode(mode, (await policy?.mode()) ?? 'all');
    } catch (error) {
      this.unreadable(mail, error);
    }
    if (mode === 'off' || (mode === 'essential' && !essential)) {
      return 'policy';
    }
    try {
      if ((await policy?.consume({ essential })) === false) return 'budget';
    } catch (error) {
      this.unreadable(mail, error);
    }
    return null;
  }

  private unreadable(mail: Type<unknown>, error: unknown) {
    this.logger.warn('Mail delivery policy unreadable: the mail may go', {
      mail: mail.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async brand() {
    try {
      const provider = markedProvider<MailBranding>(this.discovery, MailBrand);
      return (await provider?.current()) ?? DEFAULT_MAIL_BRAND;
    } catch (error) {
      this.logger.warn('Mail sent unbranded: the brand could not be read', {
        error: error instanceof Error ? error.message : String(error),
      });
      return DEFAULT_MAIL_BRAND;
    }
  }
}

/** The worker's side: sends the rendered mail a job carries. */
@Processor(MAIL_QUEUE, { concurrency: 5 })
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger('MailQueue');
  private readonly sent: Counter;
  private readonly suppressed: Counter<'reason'>;

  constructor(
    private readonly mailer: Mailer,
    private readonly discovery: DiscoveryService,
    metrics: MetricsService,
  ) {
    super();
    this.sent = new Counter({
      name: 'mail_sent_total',
      help: 'Mails the transport accepted (the mail queue, on the workers).',
      registers: [metrics.registry],
    });
    this.sent.inc(0);
    this.suppressed = new Counter({
      name: 'mail_suppressed_total',
      help: 'Recipients a mail was not sent to because the suppression list names them, by reason.',
      labelNames: ['reason'] as const,
      registers: [metrics.registry],
    });
    for (const reason of SUPPRESSION_REASONS) {
      this.suppressed.labels(reason).inc(0);
    }
  }

  /** The application's suppression list, when a module keeps one. */
  private suppression(): MailSuppression | undefined {
    return markedProvider<MailSuppression>(this.discovery, MailSuppressionList);
  }

  async process(job: Job<QueuedMail>) {
    const { essential = false, ...mail } = job.data;
    // Asked at each try: an address may have bounced since the mail was queued.
    const verdicts = await this.suppression()?.check(
      [...mail.to, ...mail.cc, ...mail.bcc].map(({ address }) => address),
      { essential, mail: job.name },
    );
    const skipped: { address: string; reason: string }[] = [];
    const allowed = (addresses: MailAddress[]) =>
      addresses.filter(({ address }) => {
        const verdict = verdicts?.get(normalizeAddress(address));
        if (verdict && !verdict.send) {
          skipped.push({ address, reason: verdict.reason });
          return false;
        }
        return true;
      });
    const to = allowed(mail.to);
    const cc = allowed(mail.cc);
    const bcc = allowed(mail.bcc);
    for (const { reason } of skipped) this.suppressed.labels(reason).inc();
    if (skipped.length > 0) {
      this.logger.warn('Mail not sent to suppressed addresses', {
        jobId: job.id,
        mail: job.name,
        reasons: skipped.map(({ reason }) => reason),
      });
    }
    if (to.length + cc.length + bcc.length === 0) {
      return { skipped };
    }
    try {
      const sent = await this.mailer.send({
        ...mail,
        to,
        cc,
        bcc,
        idempotencyKey: job.id,
        // The queue retries, over hours; the mailer makes one attempt per try.
        retry: false,
      });
      this.sent.inc();
      return { messageId: sent.messageId, skipped };
    } catch (error) {
      if (error instanceof MailError && error.permanent) {
        this.logger.warn(`Mail refused for good: ${error.message}`, {
          jobId: job.id,
        });
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }
}
