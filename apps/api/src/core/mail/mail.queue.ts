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
import { abortable } from '../queues/abortable.js';
import { DEFAULT_JOB_OPTIONS } from '../queues/queues.js';
import { mailConfig } from './mail.config.js';
import { isEssentialMail } from './mail.essential.js';
import {
  type MailSuppression,
  MailSuppressionList,
  normalizeAddress,
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
 * Sends mail through a queue: the request renders it (template, language)
 * and returns at once; a worker sends it, retrying a provider that is down
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
  ) {}

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
    const { delivery } = this.config;
    if (
      delivery === 'off' ||
      (delivery === 'essential' && !essential && !isEssentialMail(mail))
    ) {
      this.logger.warn(`Mail withheld by MAIL_DELIVERY=${delivery}`, {
        mail: mail.name,
      });
      return;
    }
    const message = await this.mailer.render(mail, options);
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
          from: message.from,
          replyTo: [...message.replyTo],
          to: [...message.to],
          cc: [...message.cc],
          bcc: [...message.bcc],
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: { ...message.headers },
          essential: essential || isEssentialMail(mail),
        },
        { jobId },
      ),
    );
  }
}

/** The worker's side: sends the rendered mail a job carries. */
@Processor(MAIL_QUEUE, { concurrency: 5 })
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger('MailQueue');

  constructor(
    private readonly mailer: Mailer,
    private readonly discovery: DiscoveryService,
  ) {
    super();
  }

  /** The application's suppression list, when a module keeps one. */
  private suppression(): MailSuppression | undefined {
    return this.discovery
      .getProviders({ metadataKey: MailSuppressionList.KEY })
      .at(0)?.instance as MailSuppression | undefined;
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
