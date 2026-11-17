import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { httpConfig } from './http.config.js';

/** Your API's name, in the document and Swagger UI's title. */
const API_TITLE = 'My API';

/**
 * Serves the OpenAPI document at `/api-json` (and `/api-yaml`), with Swagger
 * UI at `/api`, unless OPENAPI=off. Request bodies, query parameters and
 * responses come from the Zod schemas on the routes (`@Body({ schema })`):
 * Zod 4.2+ converts itself, so no converter is configured.
 */
export function setupOpenApi(app: INestApplication) {
  const config = app.get<ConfigType<typeof httpConfig>>(httpConfig.KEY, {
    strict: false,
  });
  if (!config.openApi) {
    return;
  }
  SwaggerModule.setup('api', app, () => buildOpenApiDocument(app), {
    customSiteTitle: API_TITLE,
  });
}

/**
 * The OpenAPI document of the app's routes: what `/api-json` serves, and
 * what the typed client is generated from. The tags and security schemes
 * are those of the earlier template, so the client keeps its names.
 */
export function buildOpenApiDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle(API_TITLE)
    .setDescription(
      [
        'Rename and describe your API here (src/core/http/openapi.ts).',
        '',
        "Outgoing webhooks are signed with Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`) using the endpoint's `whsec_…` secret, and carry `{ type, timestamp, data }`.",
      ].join('\n'),
    )
    .setVersion('1.0')
    .addTag('auth', 'Sign-in, sign-up, sessions, tokens and providers')
    .addTag(
      'account',
      'The signed-in user: profile, password, email, two-factor',
    )
    .addTag('access', 'Roles, users, API clients and the audit log')
    .addTag('ops', 'What runs in the background')
    .addTag(
      'data',
      'Exports and imports (CSV, JSON, Excel), as background jobs',
    )
    .addTag('webhooks', "An API client's subscriptions and delivery log")
    .addTag('incoming webhooks', 'Signed webhooks this API receives')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description:
          'An API client key (POST /access/clients): sk_<id>_<secret>.',
      },
      'api-key',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'A user access token for mobile apps and CLIs (POST /v1/auth/token), 15 minutes; renew it with POST /v1/auth/token/refresh.',
      },
      'user-token',
    )
    .addCookieAuth(
      '__Host-sid',
      {
        type: 'apiKey',
        in: 'cookie',
        description:
          'A user session: POST /v1/auth/sign-in sets the cookie, and Swagger UI on this site sends it.',
      },
      'user-session',
    )
    .build();
  return SwaggerModule.createDocument(app, config);
}
