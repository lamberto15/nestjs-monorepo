import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { I18nStandardSchemaValidationPipe } from '@nestjs/i18n';
import { I18nModule } from '../i18n/i18n.module.js';
import { useCursorKeys } from './cursor-seal.js';
import { httpConfig } from './http.config.js';
import {
  ProblemDetailsFilter,
  validationException,
} from './problem-details.filter.js';

/**
 * The API's HTTP conventions that live in the module tree: every error as
 * RFC 9457 problem details, every `@Body({ schema })` / `@Query({ schema })`
 * validated, and the keys list cursors are sealed with. What applies to the
 * app itself (headers, CORS, CSRF, versioning) is `setupHttp()`.
 */
@Module({
  imports: [ConfigModule.forFeature(httpConfig), I18nModule],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    // transform: the handler gets the parsed value. One entry per field,
    // { path, message }, in the problem's `errors`, the message in the
    // request's language (core/i18n's `validation` catalog).
    {
      provide: APP_PIPE,
      useValue: new I18nStandardSchemaValidationPipe({
        transform: true,
        exceptionFactory: validationException,
      }),
    },
  ],
})
export class HttpConventionsModule implements OnModuleInit {
  constructor(
    @Inject(httpConfig.KEY)
    private readonly config: ConfigType<typeof httpConfig>,
  ) {}

  onModuleInit() {
    if (this.config.cursorKeys.length > 0) {
      useCursorKeys(this.config.cursorKeys);
    }
  }
}
