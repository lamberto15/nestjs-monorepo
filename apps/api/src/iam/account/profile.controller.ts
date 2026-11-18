import { BadRequestException, Body, Controller, Patch } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { I18nContext, I18nService, t } from '@nestjs/i18n';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import type { UserPrincipal } from '../auth/principal.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { locale, notWhileImpersonating, timezone } from './account.schemas.js';
import { ProfileService } from './profile.service.js';

const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    locale: locale
      .nullable()
      .optional()
      .describe("null: the request's language."),
    timezone: timezone
      .nullable()
      .optional()
      .describe("null: the app's time zone."),
  })
  .strict();

const profileResultSchema = z.object({
  kind: z.literal('user'),
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  locale: z.string().nullable(),
  timezone: z.string().nullable(),
  tenantId: z.string().nullable(),
});

/** The signed-in person's own profile: their name, language and time zone. */
@ApiTags('auth')
@Controller('auth')
export class ProfileController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly i18n: I18nService,
    private readonly i18nContext: I18nContext,
  ) {}

  @UserOnly()
  @Can.Anyone()
  @Patch('me')
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({
    summary: 'Change your name, language or time zone',
    description:
      'The language answers your requests and your emails; the time zone shows the times in your emails. Dates in the API stay UTC. Never while acting as another user.',
  })
  @ApiOkResponse({ standardSchema: profileResultSchema })
  @ApiBadRequestResponse({
    description: "A language this API doesn't speak, or an unknown time zone.",
  })
  async update(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: profileSchema }) body: z.infer<typeof profileSchema>,
  ) {
    // The account is the person's, in every tenant: an administrator acting
    // as them in one tenant doesn't change it.
    notWhileImpersonating(user);
    let chosen: string | null | undefined = body.locale;
    if (chosen) {
      chosen = this.i18n.matchLocale(chosen);
      if (!chosen) {
        throw new BadRequestException({
          code: 'validation_failed',
          message: t('auth.unsupportedLocale'),
          errors: [{ path: 'locale', message: t('auth.unsupportedLocale') }],
        });
      }
    }
    const updated = await this.profiles.update(user, {
      name: body.name,
      timezone: body.timezone,
      locale: chosen,
    });
    if (chosen) {
      // Answer in the new language right away.
      this.i18nContext.setLocale(chosen);
    }
    return updated;
  }
}
