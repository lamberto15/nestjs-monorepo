import { join } from 'node:path';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { FileTemplateEngine, MailModule as NestMailModule } from '@nestjs/mail';
import { mailConfig } from './mail.config.js';
import {
  MAIL_JOB_OPTIONS,
  MAIL_QUEUE,
  MailProcessor,
  MailQueue,
} from './mail.queue.js';
import { mailTransport } from './mail.transport.js';

/**
 * Mail (@nestjs/mail, global `Mailer`) and its queue. Inject `MailQueue` and
 * `send()` a `Mailable` class: the request renders it and returns, a worker
 * sends it. Bodies are HTML templates in `core/mail/templates` (copied to
 * dist), wrapped in `layout.html`; `<name>.<locale>.html` is picked for the
 * mail's `locale`. Needs QueuesModule.
 */
@Module({
  imports: [
    NestMailModule.forRootAsync({
      imports: [ConfigModule.forFeature(mailConfig)],
      inject: [mailConfig.KEY],
      useFactory: (config: ConfigType<typeof mailConfig>) => ({
        transport: mailTransport(config),
        templates: new FileTemplateEngine({
          dir: join(import.meta.dirname, 'templates'),
          layout: 'layout',
          cache: config.cacheTemplates,
        }),
        from: config.from,
      }),
    }),
    BullModule.registerQueue({
      name: MAIL_QUEUE,
      defaultJobOptions: MAIL_JOB_OPTIONS,
    }),
  ],
  providers: [MailQueue, MailProcessor],
  exports: [MailQueue],
})
export class MailModule {}
