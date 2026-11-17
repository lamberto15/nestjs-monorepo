import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import {
  AcceptLanguageLocaleResolver,
  HeaderLocaleResolver,
  I18nModule as NestI18nModule,
  LocaleResolver,
  QueryLocaleResolver,
  type LocaleResolverInput,
} from '@nestjs/i18n';
import { ModuleCatalogLoader } from './catalog.loader.js';
import { i18nConfig } from './i18n.config.js';

/**
 * The language a signed-in user saved (`locale` on `request.user`): it beats the
 * browser's Accept-Language. Runs after the authentication guard.
 */
class UserLocaleResolver extends LocaleResolver {
  readonly afterGuards = true;

  resolve({ executionContext }: LocaleResolverInput) {
    const request = executionContext
      ?.switchToHttp()
      .getRequest<{ user?: { locale?: string | null } | null }>();
    return request?.user?.locale ?? undefined;
  }
}

/**
 * Translations (@nestjs/i18n; global). Texts come from every
 * `<module>/i18n/<locale>.json`. The locale is `?lang=`, then `X-Lang`, then the
 * user's saved language, then Accept-Language, then the first of LOCALES;
 * responses carry `Content-Language`. The `validation` catalog here words
 * the request validation errors (core/http's pipe). Work outside a request (jobs, mail) passes the
 * recipient's `locale` to `t()`.
 */
@Module({
  imports: [
    NestI18nModule.forRootAsync({
      imports: [ConfigModule.forFeature(i18nConfig)],
      inject: [i18nConfig.KEY],
      useFactory: (config: ConfigType<typeof i18nConfig>) => ({
        defaultLocale: config.locales[0],
        supportedLocales: config.locales,
        // import.meta.dirname is core/i18n: two levels up is src (or dist).
        loader: new ModuleCatalogLoader(
          join(import.meta.dirname, '../..'),
          config.locales,
        ),
        missingKey: config.missingKey,
      }),
      resolvers: [
        new QueryLocaleResolver('lang'),
        new HeaderLocaleResolver('x-lang'),
        new UserLocaleResolver(),
        new AcceptLanguageLocaleResolver(),
      ],
    }),
  ],
})
export class I18nModule {}
