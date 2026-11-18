import { Controller, Get } from '@nestjs/common';
import { CurrentSession, CurrentUser, Public } from '@nestjs/authentication';
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
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import {
  declaredShape,
  openApiAdditions,
  setResponseSchema,
} from '../../core/http/openapi.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuthPolicy } from './auth-policy.js';
import { DuringMfaEnrollment } from './mfa-enrollment.guard.js';
import { DuringOnboarding } from './onboarding.js';
import { OperatorGuard } from './operator-only.js';
import type { UserPrincipal } from './principal.js';
import { SessionLifetime } from './session-lifetime.js';
import { WithoutSso } from './sign-in-gate.js';
import { UserOnly } from './user-only.decorator.js';
import { SignInMethodsPart, WhoAmIPart, WhoAmIParts } from './who-am-i.js';

const userSchema = z.object({
  kind: z.literal('user'),
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  locale: z.string().nullable(),
  timezone: z.string().nullable(),
  tenantId: z.string().nullable(),
  impersonator: z
    .object({ id: z.string(), email: z.string() })
    .optional()
    .describe('Set while an administrator acts as you.'),
  breakGlass: z
    .object({
      grantId: z.string(),
      tenantId: z.string(),
      operatorTenantId: z.string(),
      expiresAt: z.iso.datetime(),
    })
    .optional()
    .describe(
      'Set while you read this tenant through a break-glass grant (Break-Glass header): read only, until expiresAt.',
    ),
});

// Loose: the modules' parts (@WhoAmIPart()) add their keys.
const meSchema = z.looseObject({
  user: userSchema,
  tenant: z
    .object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      operator: z
        .boolean()
        .describe(
          "true: the deployment's operators' tenant (the operators' routes answer in it only).",
        ),
    })
    .nullable()
    .describe('The tenant this session or token acts in; null: none.'),
  mfaEnrollmentRequired: z
    .boolean()
    .describe(
      'true: this tenant requires two-factor and you have none: set it up (POST /auth/mfa/enroll, then /confirm); until then other routes answer 403 `mfa_enrollment_required`.',
    ),
  onboardingRequired: z
    .object({ email: z.boolean(), password: z.boolean() })
    .nullable()
    .describe(
      'Not null: the first administrator still has to replace the placeholder email and/or the generated password; until then other routes answer 403 `onboarding_required`.',
    ),
  session: z
    .object({
      idleMinutes: z.number().int(),
      lastActiveAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
    })
    .nullable()
    .describe(
      "A browser session's lifetime (the tenant's policy under the deployment's), for a warning before it ends; null for a token or an impersonation.",
    ),
});

// Loose: the modules' parts (@SignInMethodsPart()) add their keys.
const methodsSchema = z.looseObject({ password: z.literal(true) });

// The document carries every part's keys with its schema: the parts are
// found on the app's providers when it is built (the route's own schema
// above can't name them).
openApiAdditions.document.set('who-am-i', (document, app) => {
  setResponseSchema(
    document,
    '/v1/auth/me',
    z.object({ ...meSchema.shape, ...declaredShape(app, WhoAmIPart) }),
  );
  setResponseSchema(
    document,
    '/v1/auth/methods',
    z.object({
      ...methodsSchema.shape,
      ...declaredShape(app, SignInMethodsPart),
    }),
  );
});

/**
 * Who is signed in, and how one may sign in here: what a frontend reads
 * first. Each answer is auth's own fields plus the parts other modules add
 * (`@WhoAmIPart()`, `@SignInMethodsPart()`, who-am-i.ts). It shows what
 * a frontend may offer; the routes check again, so it grants nothing.
 */
@ApiTags('auth')
@Controller('auth')
export class WhoAmIController {
  constructor(
    private readonly parts: WhoAmIParts,
    private readonly tenancy: Tenancy,
    private readonly operators: OperatorGuard,
    private readonly policy: AuthPolicy,
    private readonly lifetime: SessionLifetime,
  ) {}

  @UserOnly()
  @Can.Anyone()
  @DuringMfaEnrollment()
  @DuringOnboarding()
  @WithoutSso()
  @AllowInMaintenance()
  @Get('me')
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({ summary: 'The signed-in user and what they may do' })
  @ApiOkResponse({ standardSchema: meSchema })
  @ApiUnauthorizedResponse({ description: 'Not signed in.' })
  async me(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
  ) {
    const tenant = user.tenantId
      ? await this.tenancy.find(user.tenantId)
      : undefined;
    const { onboarding, ...principal } = user;
    const [operator, mfaEnrollmentRequired, lifetime, parts] =
      await Promise.all([
        this.operators.actsAsOperator(user),
        this.policy.mfaEnrollmentRequired(user),
        this.lifetime.describe(session, user),
        this.parts.whoAmI({ user, session }),
      ]);
    return {
      ...parts,
      user: principal,
      tenant: tenant
        ? { id: tenant.id, slug: tenant.slug, name: tenant.name, operator }
        : null,
      mfaEnrollmentRequired,
      onboardingRequired: onboarding ?? null,
      session: lifetime,
    };
  }

  @Public()
  @AllowInMaintenance()
  @Get('methods')
  @ApiOperation({ summary: 'How users can sign in here, for the sign-in page' })
  @ApiOkResponse({ standardSchema: methodsSchema })
  async methods() {
    return { ...(await this.parts.signInMethods()), password: true as const };
  }
}
