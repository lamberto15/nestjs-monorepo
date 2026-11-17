import { randomUUID } from 'node:crypto';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, type Type } from '@nestjs/common';
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
  constructor(
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue<QueuedMail>,
    private readonly mailer: Mailer,
  ) {}

  async send<M extends Mailable<any>>(
    mail: Type<M>,
    options: MailableRenderOptions<Parameters<M['render']>[0]>,
    {
      jobId = randomUUID(),
      signal,
    }: {
      /** Your own job id when the call may repeat (a retried handler): the mail goes once. */
      jobId?: string;
      /** Stops waiting for Redis (the add may still land: the job id makes that harmless). */
      signal?: AbortSignal;
    } = {},
  ) {
    signal?.throwIfAborted();
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

  constructor(private readonly mailer: Mailer) {
    super();
  }

  async process(job: Job<QueuedMail>) {
    try {
      const sent = await this.mailer.send({
        ...job.data,
        idempotencyKey: job.id,
        // The queue retries, over hours; the mailer makes one attempt per try.
        retry: false,
      });
      return { messageId: sent.messageId };
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
