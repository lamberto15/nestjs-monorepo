# API conventions

What every route follows. The code is in
[`apps/api/src/core/http`](../apps/api/src/core/http/README.md);
`main.ts` and the e2e tests set it up with `createHttpAdapter()` and
`setupHttp(app)`. A module never repeats these rules: it declares what is
its own and the shared code does the rest.

## Versions

Routes are versioned in the URI: `/v1/...` is the default. A breaking change
ships as `/v2` next to `/v1` (`@Version('2')` on a route, or
`@Controller({ version: '2' })`). A route with no version uses
`VERSION_NEUTRAL`: `/health`, `/metrics`, and the docs at `/api`.

## Errors

Every error is RFC 9457 problem details, `Content-Type:
application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "The request is invalid.",
  "code": "validation_failed",
  "errors": [{ "path": "email", "message": "…" }],
  "instance": "/v1/auth/sign-in",
  "requestId": "…"
}
```

- `code` is stable and for programs; `detail` is for people. An exception
  that names no code gets one from its status: `bad_request`,
  `unauthorized`, `forbidden`, `not_found`, `conflict`,
  `precondition_failed`, `payload_too_large`, `unprocessable_entity`,
  `rate_limited`, `internal_error`, `unavailable`.
- `errors` lists the fields of a `validation_failed`, each with a dotted
  `path` (`items.0.quantity`).
- An unexpected error answers 500 with a fixed message. Its internals stay in
  the logs, found by `requestId`.
- Other fields an exception carries are kept (`retryAfter`, `etag`).
  A `retryAfter` on a 503 also sets `Retry-After`.
- A module whose own errors are not `HttpException`s maps them in its folder:
  `ProblemDetailsFilter.map(MyError, (error) => new ConflictException(...))`.
- Modules add their own codes (`feature_off`, `reauthentication_required`,
  `legal_hold`...): each module README lists its own.

## Request ids

Every response has `X-Request-Id`. A request's own value is kept when it is
8 to 128 characters of `A-Za-z0-9._:-`; otherwise a UUID replaces it. The
problem details repeat it as `requestId`.

## Validation and declaring a route

Bodies, queries and parameters are validated with Zod schemas, through the
global `StandardSchemaValidationPipe`:

```ts
@Post()
@IdempotentRoute()
@ApiCreatedResponse({ standardSchema: legalHoldSchema })
place(@Body({ schema: placeLegalHoldSchema }) dto: PlaceLegalHoldDto) {}

@Get()
@ApiOkResponse({ standardSchema: legalHoldPageSchema })
list(@Query({ schema: LEGAL_HOLD_LIST.schema }) query: ListQuery) {}
```

(From `apps/api/src/iam/holds/holds.controller.ts`.) The same schemas
produce the OpenAPI document, so request and response types cannot drift from
what the route accepts. A path parameter is `@Param('id', ParseUUIDPipe)` or
`@Param('id', { schema })`. JSON bodies are limited to 100 KB (413
`payload_too_large`) and a path parameter to 2048 characters (414).

## Lists

A list route declares its fields once with `listQuery()`
(`list-query.ts`), and `@ApiListQuery()` documents them. Only declared
fields, operators and sorts are accepted: anything else is a 400 that names
it.

- **Filters.** Flat: `?status=draft`, `?status.in=a,b`,
  `?title.contains=x`, `?createdAt.gte=...`. Operators: `eq`, `ne`,
  `in`, `notIn`, `contains`, `notContains`, `startsWith`,
  `endsWith`, `gt`, `gte`, `lt`, `lte`, `between`, `isNull`.
  Nested: `?filter=` takes a JSON tree of `and` and `or` groups (at most
  30 conditions and 3 levels). Both are combined with AND, and the caller's
  read permission is applied outside all of it.
- **Sorting.** `?sort=-createdAt,title`: declared sortable fields (at most
  3), then the id.
- **Fields.** `?fields=title,status` returns only those (and `id`).
- **Pages.** `?limit=` (default 50, at most 100) and `?cursor=` answer
  `{ items, nextCursor }`; `nextCursor: null` ends the list. `?page=3`
  pages by number instead, and `?count=true` adds `total` (counted up to a
  cap, with `totalCapped`) and `pageCount`. Pass the cursor back with the
  same `sort`.
- **Cursors are sealed.** A sorted cursor carries the last row's sort values,
  which a field permission may hide, so it is AES-GCM ciphertext under
  `CURSOR_KEYS`. A cursor that was changed, made for another sort or sealed
  with a key no longer listed is a 400. Without `CURSOR_KEYS` a key made once
  is kept in the database, so every instance opens the others' cursors
  ([deployment](deployment.md#more-than-one-instance)).
- A field the caller may not read cannot be filtered, searched or sorted by
  (it would reveal values one probe at a time): the list refuses the query.

## ETags and If-Match

A route marked `@Etag()` answers with a strong `ETag` (the hash of what it
sends) and `Cache-Control: private, no-cache`. A `GET` with a matching
`If-None-Match` gets 304. A write may send `If-Match` with the tag it read:
if the record changed, the answer is 412 `precondition_failed` (the current
`etag` is in the body). Without `If-Match` the write goes ahead; `*`
always matches. A service checks it with `assertUnchanged()`. Records
answer every read with a tag and check `If-Match` on writes: [modules/records](../apps/api/src/modules/records/README.md).

## Idempotency-Key

A write route takes `@IdempotentRoute()`
([core/idempotency](../apps/api/src/core/idempotency/README.md)). A retry
with the same key gets the first response, marked `Idempotent-Replayed:
true`. The same key with another body is a 422 `IDEMPOTENCY_KEY_REUSED`. A
missing key is a 400 `IDEMPOTENCY_KEY_REQUIRED` when `IDEMPOTENCY=required`
(the default). Keys are kept 24 hours, per caller and tenant.

## Rate limits

Every route is limited to 600 requests a minute per client address, counted
in Redis so the limit holds across instances. Over it: 429 `rate_limited`
with `Retry-After`. A route tightens it with `@Throttle()` or opts out
with `@SkipThrottle()`; sign-in routes use `@AddressThrottle()` and
`@UserThrottle()`. See [core/throttling](../apps/api/src/core/throttling/README.md).
The client address comes from `X-Forwarded-For`, trusted only from loopback
and private networks.

## CORS and CSRF

A web app on the API's own origin needs nothing. Other browser origins are
listed in `CORS_ORIGINS`: they may call the API with the session cookie, and
they may write. CORS exposes `X-Request-Id`, `Retry-After`,
`Content-Language`, `ETag`, `Location` and `Idempotent-Replayed`.

Every other website's page is refused a write with 403 (CSRF protection on
all routes). Requests that send no `Origin` or `Sec-Fetch-Site` (curl,
other servers, webhooks) are not affected. A route another site must post to
(a SAML sign-in) is added to `csrfExclusions` by its module and
authenticates the post itself.

## Security headers

Responses carry HSTS (two years, subdomains included), `nosniff`, and a
strict Content-Security-Policy. Outside production the CSP leaves out
`upgrade-insecure-requests` so plain-HTTP development works. Responses are
gzip-compressed.

## Deprecation

`@Deprecated({ since, sunset?, link?, successor? })` on a route or controller
adds `Deprecation` (RFC 9745), `Sunset` (RFC 8594) and `Link` headers,
marks the operation `deprecated` in OpenAPI (the typed client gets
`@deprecated`), and counts calls in the metric
`deprecated_route_calls_total`. Remove a route only after its sunset date
shows no calls.

## Switches and maintenance

- `@Feature({ name: schema })` on a provider reports one switch of
  `GET /v1/features`. The module that owns the capability reads its own
  setting, so the answer cannot disagree with its routes
  ([modules/features](../apps/api/src/modules/features/README.md)). A route
  behind a deployment switch answers 404 `feature_off` when it is off.
- `APP_MODE` or the `platform.mode` setting makes the deployment read-only
  or in maintenance: writes (or everything) answer 503 `read_only` or
  `maintenance` with `Retry-After: 30`. A route that must keep working
  carries `@AllowInMaintenance()`: health, sign-in, the operators' routes
  ([modules/mode](../apps/api/src/modules/mode/README.md)).

## OpenAPI and the realtime manifest

`/api` serves Swagger UI and `/api-json` the document (`OPENAPI=off` serves
neither). Request, query and response schemas come from the routes' Zod
schemas. `pnpm openapi:dump` writes the document without starting the app,
and `pnpm client:generate` builds the typed client in `packages/api-client`
from it (`pnpm client:check` fails when the committed client is stale).

The document also has `x-realtime-events`: for each event a module defines
with `defineRealtimeEvent`, its name, description and a payload schema
(a component named `Realtime<Name>Event`). The typed client turns it into
`RealtimeEventPayloads`. See [modules/realtime](../apps/api/src/modules/realtime/README.md).

## Credentials

A route needs credentials unless it is marked `@Public()`. Three kinds are
accepted ([iam/auth](../apps/api/src/iam/auth/README.md)):

- **Session cookie** (`__Host-sid`; `sid` when `SESSION_COOKIE_SECURE` is
  off), set by `POST /v1/auth/sign-in`. For browsers.
- **Bearer access token** (a JWT, 15 minutes) for mobile apps and CLIs:
  `Authorization: Bearer <token>`, from `POST /v1/auth/token`, renewed with
  `POST /v1/auth/token/refresh`.
- **API key** for systems: `Authorization: Bearer sk_<id>_<secret>`, made
  under `/v1/access/clients` ([iam/api-clients](../apps/api/src/iam/api-clients/README.md)).

Who may do what is a separate question: see [identity](identity.md).
