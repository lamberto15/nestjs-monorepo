# core/http

The HTTP conventions every route shares (the earlier template's
docs/api-conventions.md).

- **Errors** are RFC 9457 problem details (`application/problem+json`):
  `type`, `title`, `status`, `detail`, a stable `code`, `instance`,
  `requestId`, and `errors: [{ path, message }]` for validation. Unexpected
  errors never show their internals. A module whose errors aren't
  `HttpException`s maps them in its own folder:
  `ProblemDetailsFilter.map(MyError, (error) => new ConflictException(…))`.
- **Validation**: `@Body({ schema })`, `@Query({ schema })`,
  `@Param('id', { schema })` with Zod, through Nest's
  `StandardSchemaValidationPipe` (global).
- **The app** (`createHttpAdapter()`, `setupHttp(app)`, called by main.ts and
  the e2e tests): request ids, the JSON body limit (100 KB, `body-limit.ts`),
  security headers, gzip, CORS, CSRF, URI versioning (`/v1`; version-neutral
  routes with `VERSION_NEUTRAL`), proxy trust and the path-parameter limit.
- **Lists**: `listQuery()` (filters, `filter=`, `sort=`, `fields=`),
  cursor and page pagination (`pagination.ts`; sorted cursors sealed by
  `cursor-seal.ts`), `@ApiListQuery()`.
- `@Etag()` and `assertUnchanged()`, `@Deprecated()`, `redirectPath`,
  `routeKey`, `safeFetch()` (an SSRF-guarded fetch).
- **OpenAPI**: `setupOpenApi(app)` serves `/api` and `/api-json`.

## Variables

| Variable       | Default | Meaning                                                              |
| -------------- | ------- | -------------------------------------------------------------------- |
| `CORS_ORIGINS` | none    | Browser apps on other origins, comma-separated: CORS and CSRF trust. |
| `CURSOR_KEYS`  | none    | Keys sealing list cursors, newest first; unset, one per process.     |
| `OPENAPI`      | `on`    | `off` serves no `/api`.                                              |
| `NODE_ENV`     | none    | `production` keeps CSP's `upgrade-insecure-requests`.                |

## Removing it

Not removable: every route relies on it.
