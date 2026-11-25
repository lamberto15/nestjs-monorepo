# core/http

The HTTP conventions every route shares; [docs/api-conventions.md](../../../../../docs/api-conventions.md)
says how a route uses them.

- **Errors** are RFC 9457 problem details (`application/problem+json`):
  `type`, `title`, `status`, `detail`, a stable `code`, `instance`,
  `requestId`, and `errors: [{ path, message }]` for validation. Unexpected
  errors never show their internals. A module whose errors aren't
  `HttpException`s maps them in its own folder:
  `ProblemDetailsFilter.map(MyError, (error) => new ConflictException(…))`.
  A busy pool or a cancelled statement is a 503 `database_busy` /
  `database_timeout` with Retry-After, a unique violation no service mapped a
  409 `conflict`, a value the database could not read (a malformed id) a 400 `invalid_value`
  (`infrastructure-errors.ts`).
- **Validation**: `@Body({ schema })`, `@Query({ schema })`,
  `@Param('id', { schema })` with Zod, through Nest's
  `StandardSchemaValidationPipe` (global).
- **Responses** (`response-schema.interceptor.ts`, global): each response is
  run, as JSON, through the schema its route documents for the status it
  answers with (`@ApiOkResponse({ standardSchema })`, or
  `@SerializeOptions({ schema })`): undeclared keys are dropped, and a
  response off its schema is a 500 naming the route and keys in the log.
  Nest's `StandardSchemaSerializerInterceptor`, with the schema read from
  the OpenAPI entry so it is written once. Not checked: `?fields=` and
  `?include=` responses (built from declared names only).
- **The app** (`createHttpAdapter()`, `setupHttp(app)`, called by main.ts and
  the e2e tests): request ids, the JSON body limit (100 KB, `body-limit.ts`),
  security headers, gzip, CORS, CSRF, URI versioning (`/v1`; version-neutral
  routes with `VERSION_NEUTRAL`), proxy trust and the path-parameter limit.
- **Lists**: `listQuery()` (filters, `filter=`, `sort=`, `fields=`),
  cursor and page pagination (`pagination.ts`; sorted cursors sealed by
  `cursor-seal.ts`), `@ApiListQuery()`.
- `@Etag()` and `assertUnchanged()`, `@Deprecated()`, `redirectPath`,
  `routeKey`, `safeFetch()` (an SSRF-guarded fetch). Its rules, for a client
  that is not `fetch`: `destinationProblem(url)` (https, no credentials, an
  IP literal's address; also a schema's check) and `guardedLookup()` (a
  socket's `lookup` that refuses private, loopback, link-local and metadata
  addresses at connect time). Web push uses both (modules/notifications).
- `@AllowInMaintenance()` (`maintenance.ts`): a route that keeps answering
  while modules/mode has the deployment read only or in maintenance.
- `@Feature({ name: schema })` (`feature.ts`) on a provider implementing
  `FeatureSwitch` is one key of `GET /v1/features` (modules/features);
  `switchFeature()` makes an on/off one.
- **OpenAPI**: `setupOpenApi(app)` serves `/api`, `/api-json` and `/api-yaml`.

## Variables

| Variable       | Default                   | Meaning                                                                              |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `APP_URL`      | `http://localhost:3000`   | This API's public origin, for the links it hands out (signed file URLs, mails).      |
| `WEB_URL`      | APP_URL                   | The web app's base URL: mail links open its pages, OIDC and SSO sign-ins land on it. |
| `CORS_ORIGINS` | none                      | Browser apps on other origins, comma-separated: CORS and CSRF trust.                 |
| `CURSOR_KEYS`  | none                      | Keys sealing list cursors, newest first; unset, one kept in the database.            |
| `OPENAPI`      | `on`, `off` in production | `off` serves no `/api`.                                                              |
| `TRUST_PROXY`  | private networks          | The proxies whose `X-Forwarded-For` gives the client address; name yours.            |
| `NODE_ENV`     | none                      | `production` keeps CSP's `upgrade-insecure-requests`.                                |

## Removing it

Not removable: every route relies on it.
