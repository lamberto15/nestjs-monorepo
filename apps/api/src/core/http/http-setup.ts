import { type RequestMethod, VersioningType } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { type NestNodeApplication, NodeAdapter } from '@nestjs/platform-node';
import compression from 'compression';
import { JSON_BODY_LIMIT } from './body-limit.js';
import { readEnv } from '../config/env.js';
import {
  DEFAULT_TRUSTED_PROXIES,
  httpConfig,
  schema as httpSchema,
} from './http.config.js';
import { assignRequestId } from './request-id.js';
import { recordMatchedRoutes } from './route-key.js';

/** The response headers a browser app on CORS_ORIGINS may read (`Access-Control-Expose-Headers`). */
export const CORS_EXPOSED_HEADERS = [
  'X-Request-Id',
  'Retry-After',
  'Content-Language',
  'ETag',
  'Location',
  'Idempotent-Replayed',
] as const;

/** The longest path parameter a route matches, in characters (decoded). */
export const MAX_PARAM_LENGTH = 2048;

/**
 * The HTTP server: Nest's native `node:http` adapter (@nestjs/platform-node),
 * which main.ts and the e2e tests both create the app with. Its settings are
 * constructor options, so they can't be applied to an app afterwards.
 *
 * Behind a proxy: the client's address (rate limits, audit) comes from
 * X-Forwarded-For, trusted from TRUST_PROXY's addresses only (loopback and
 * private networks when unset). Addresses, never a hop count: the adapter
 * trusts no proxy for a number (it can't tell a proxy from a client sending
 * its own header). Read here, not from the config module: the adapter is
 * made before the app.
 */
export function createHttpAdapter() {
  const { TRUST_PROXY } = readEnv(httpSchema.pick({ TRUST_PROXY: true }));
  const adapter = new NodeAdapter({
    trustProxy: TRUST_PROXY.length > 0 ? TRUST_PROXY : DEFAULT_TRUSTED_PROXIES,
    // A path parameter longer than this is a 414 (the adapter's default is
    // 100): the one-click unsubscribe link carries a signed JWT in its path,
    // a few hundred characters.
    maxParamLength: MAX_PARAM_LENGTH,
  });
  recordMatchedRoutes(adapter.getInstance());
  // The JSON parser's SyntaxError (an http-error, 400) reaches the filter as
  // it is: the adapter would make it a BadRequestException carrying the
  // parser's message, which quotes the body. ProblemDetailsFilter answers it
  // with the status's own words, as every other parser error.
  const mapException = adapter.mapException.bind(adapter);
  adapter.mapException = (error: unknown) =>
    error instanceof SyntaxError && 'statusCode' in error
      ? error
      : mapException(error);
  return adapter;
}

/**
 * Routes another website's page must be able to post to, which the CSRF
 * protection would refuse: the module that owns one adds it here when its
 * file loads (iam/sso: a SAML identity provider posts the sign-in to the
 * assertion consumer route). Keyed, so a second app in one process (tests)
 * replaces the entry. Each such route authenticates the post itself.
 */
export const csrfExclusions = new Map<
  string,
  { path: string; method: RequestMethod; version?: string }
>();

/**
 * The HTTP conventions applied to the app itself (main.ts and the e2e tests
 * call it before `init()`): request ids, the JSON body limit, security
 * headers, compression, CORS, CSRF and URI versioning. The global filter and
 * validation pipe come with HttpConventionsModule, which must be imported:
 * this reads its configuration.
 */
export function setupHttp(app: NestNodeApplication) {
  const config = app.get<ConfigType<typeof httpConfig>>(httpConfig.KEY, {
    strict: false,
  });
  const origins = config.corsOrigins;

  // First of all: every response, a body parser's error or a CSRF refusal
  // included, carries its id.
  app.use(assignRequestId);

  // JSON bodies: up to JSON_BODY_LIMIT (body-limit.ts), then 413
  // payload_too_large. Registered here, Nest's own JSON parser is skipped.
  app.useBodyParser('json', {
    type: ['application/json', 'application/*+json'],
    limit: JSON_BODY_LIMIT,
  });

  // HTML form posts: only SAML's HTTP-POST binding sends them (the assertion
  // consumer service, iam/sso), a signed assertion of a few KB. Registered
  // here, the adapter's own (extended, 1000 parameters) is skipped.
  app.useBodyParser('urlencoded', {
    extended: false,
    limit: '512kb',
    parameterLimit: 10,
  });

  // HSTS, nosniff, a strict CSP (Swagger UI's assets are served from this
  // origin, so it works with the default policy)...
  app.useSecurityHeaders({
    // Two years, subdomains included: the app is only ever served over HTTPS.
    strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true },
    // Plain-HTTP development would otherwise have Swagger UI's assets upgraded to https://.
    ...(!config.production && {
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    }),
  });

  // gzip, as the Compression chapter shows for Express-style adapters.
  // `compression` leaves ETag and every other header untouched, so a 304
  // still matches; `text/event-stream` isn't compressible, so event streams
  // still flush each event unbuffered.
  app.use(compression());

  // Browser apps on other origins (CORS_ORIGINS) may call the API with the
  // session cookie. Same-origin apps need nothing.
  if (origins.length > 0) {
    app.enableCors({
      origin: origins,
      credentials: true,
      exposedHeaders: [...CORS_EXPOSED_HEADERS],
      maxAge: 600,
    });
  }

  // Refuses writes from other websites' pages with a 403 on every route.
  // curl, API clients' systems and webhooks send no Origin or Sec-Fetch-Site
  // and are unaffected. CORS_ORIGINS may write.
  app.enableCsrfProtection({
    trustedOrigins: origins,
    exclude: [...csrfExclusions.values()],
  });

  // /v1/notes: a breaking change ships as /v2 next to it (`@Version('2')` on
  // a route or `@Controller({ version: '2' })`). /health and the docs carry
  // no version (`VERSION_NEUTRAL`).
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}
