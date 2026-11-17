import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { MailModule as NestMailModule } from '@nestjs/mail';
import { mailConfig } from './mail.config.js';
import {
  MAIL_JOB_OPTIONS,
  MAIL_QUEUE,
  MailProcessor,
  MailQueue,
} from './mail.queue.js';
import {
  LAYOUT_DIR,
  ModuleTemplateEngine,
  SOURCE_ROOT,
} from './mail.templates.js';
import { mailTransport } from './mail.transport.js';

/**
 * Mail (@nestjs/mail, global `Mailer`) and its queue. Inject `MailQueue` and
 * `send()` a `Mailable` class: the request renders it and returns, a worker
 * sends it. Bodies are HTML templates in each module's own `templates/`
 * folder (found under src or dist, copied by nest-cli.json), wrapped in the
 * shared `core/mail/templates/layout.html`; `<name>.<locale>.html` is
 * picked for the mail's `locale`. Needs QueuesModule.
 */
@Module({
  imports: [
    NestMailModule.forRootAsync({
      imports: [ConfigModule.forFeature(mailConfig)],
      inject: [mailConfig.KEY],
      useFactory: (config: ConfigType<typeof mailConfig>) => ({
        transport: mailTransport(config),
        templates: new ModuleTemplateEngine(
          [SOURCE_ROOT, ...config.templateRoots],
          LAYOUT_DIR,
          config.cacheTemplates,
        ),
        from: config.from,
      }),
    }),
    ConfigModule.forFeature(mailConfig),
    DiscoveryModule,
    BullModule.registerQueue({
      name: MAIL_QUEUE,
      defaultJobOptions: MAIL_JOB_OPTIONS,
    }),
  ],
  providers: [MailQueue, MailProcessor],
  exports: [MailQueue],
})
export class MailModule {}
