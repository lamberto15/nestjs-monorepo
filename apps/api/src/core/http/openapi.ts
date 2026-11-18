import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  DiscoveryService,
  ModulesContainer,
  type DiscoverableDecorator,
} from '@nestjs/core';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { z } from 'zod';
import { httpConfig } from './http.config.js';

/**
 * What a module adds to the published document and to Swagger UI, keyed by
 * the module's name so a second app in one process (tests) replaces its
 * entry: core/idempotency marks its header optional and fills it in.
 */
export const openApiAdditions = {
  document: new Map<
    string,
    (document: OpenAPIObject, app: INestApplication) => void
  >(),
  swaggerOptions: {} as Record<string, unknown>,
};

/**
 * Publishes named Zod schemas (`.meta({ id })`, and the named schemas they
 * contain) as components of the document, whether or not a route uses them.
 * A record add-on's routes exist only for the features that take it
 * (`XModule.forRecord()`), but the typed client's panels type their answers
 * from these components, so they must be there with no feature at all. Call
 * it where the schemas are defined; `key` names the addition, so a second
 * app in one process replaces it.
 */
export function publishSchemas(key: string, ...schemas: z.ZodType[]) {
  openApiAdditions.document.set(key, (document) => {
    const components = ((document.components ??= {}).schemas ??= {});
    for (const schema of schemas) {
      const { $schema: _, ...json } = z.toJSONSchema(schema, {
        target: 'openapi-3.0',
        io: 'output',
        unrepresentable: 'any',
      }) as Record<string, unknown>;
      const named = (json.definitions ?? json.$defs ?? {}) as Record<
        string,
        unknown
      >;
      for (const [id, definition] of Object.entries(named)) {
        components[id] ??= JSON.parse(
          JSON.stringify(definition)
            .replaceAll('"#/$defs/', '"#/components/schemas/')
            .replaceAll('"#/definitions/', '"#/components/schemas/'),
        ) as (typeof components)[string];
      }
    }
  });
}

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
    swaggerOptions: openApiAdditions.swaggerOptions,
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
  const document = SwaggerModule.createDocument(app, config);
  for (const add of openApiAdditions.document.values()) add(document, app);
  return document;
}

/**
 * The Zod shapes the app's providers declare with `decorator`, merged: the
 * keys of an answer assembled from modules' parts (`@WhoAmIPart()`,
 * `@Feature()`). Read from the classes, so it works in openapi-dump's preview
 * mode, where nothing is instantiated but Nest's core module (which
 * provides ModulesContainer).
 */
export function declaredShape<T extends z.ZodRawShape>(
  app: INestApplication,
  decorator: DiscoverableDecorator<T>,
): z.ZodRawShape {
  const discovery = new DiscoveryService(app.get(ModulesContainer));
  const shape: z.ZodRawShape = {};
  for (const wrapper of discovery.getProviders({
    metadataKey: decorator.KEY,
  })) {
    Object.assign(shape, discovery.getMetadataByDecorator(decorator, wrapper));
  }
  return shape;
}

/**
 * Replaces the 200 answer's schema of `GET path` with `schema`: for an
 * answer whose keys the route's own decorator can't know, as modules loaded
 * after it contribute them (declaredShape). Named parts become components.
 */
export function setResponseSchema(
  document: OpenAPIObject,
  path: string,
  schema: z.ZodType,
) {
  const answer = document.paths[path]?.get?.responses['200'];
  const content = answer && 'content' in answer ? answer.content : undefined;
  if (!content?.['application/json']) return;
  const {
    $schema: _,
    $defs,
    definitions,
    ...converted
  } = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'output',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  const point = <T>(value: unknown) =>
    JSON.parse(
      JSON.stringify(value)
        .replaceAll('"#/$defs/', '"#/components/schemas/')
        .replaceAll('"#/definitions/', '"#/components/schemas/'),
    ) as T;
  const components = ((document.components ??= {}).schemas ??= {});
  for (const [id, definition] of Object.entries(
    (definitions ?? $defs ?? {}) as Record<string, unknown>,
  )) {
    components[id] ??= point(definition);
  }
  content['application/json'].schema = point(converted);
}
