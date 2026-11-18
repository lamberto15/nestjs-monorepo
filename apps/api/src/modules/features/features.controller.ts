import { Controller, Get } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { DuringMfaEnrollment } from '../../iam/auth/mfa-enrollment.guard.js';
import { DuringOnboarding } from '../../iam/auth/onboarding.js';
import { Feature } from '../../core/http/feature.js';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import {
  declaredShape,
  openApiAdditions,
  setResponseSchema,
} from '../../core/http/openapi.js';
import { FeaturesService } from './features.service.js';

const featuresSchema = z
  .record(z.string(), z.union([z.boolean(), z.string(), z.array(z.string())]))
  .describe(
    'Each switch by name: true or false, or a value (`mode`, `locales`). Which names exist depends on the modules the deployment runs.',
  );

// The document names every switch the app's modules declare (`@Feature()`),
// with its value's schema, so a client is typed by them.
openApiAdditions.document.set('features', (document, app) => {
  setResponseSchema(
    document,
    '/v1/features',
    z.object(declaredShape(app, Feature)).describe(featuresSchema.description!),
  );
});

/** Which deployment switches are on, for a client to hide what is off. */
@ApiTags('features')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('features')
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  @Get()
  @Can.Anyone() // Any signed-in caller: it says nothing about the data.
  // Deployment-wide switches: the web shell reads them to draw the two-factor setup.
  @DuringMfaEnrollment()
  @DuringOnboarding()
  // The web shell reads the mode here, also while it is `maintenance`.
  @AllowInMaintenance()
  @ApiOperation({
    summary: 'Which switches are on in this deployment',
    description:
      "The deployment switches of the modules that are installed (`realtime`, `passkeys`, `signUp`, `mode`, `locales`...). A switch that is off leaves its routes out (404) or refuses them (404 `feature_off`). Read at startup: a change needs a restart. A tenant's own feature flags are settings (`GET /v1/settings`).",
  })
  @ApiOkResponse({ standardSchema: featuresSchema })
  list() {
    return this.features.current();
  }
}
