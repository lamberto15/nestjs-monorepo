# core/idempotency: Idempotency-Key

`@nestjs/idempotency` with a PostgreSQL store (`idempotency_keys`, `SharedIdempotencyModule`, global). A write route takes `@IdempotentRoute()` (or `{ required: false }` for its own choice): a retry with the same key gets the first response (`Idempotent-Replayed: true`), the same key with another body is a 422 `IDEMPOTENCY_KEY_REUSED`, a missing one a 400 `IDEMPOTENCY_KEY_REQUIRED` (IDEMPOTENCY=required, the default). Records live 24 hours, are sealed at rest (IDEMPOTENCY_KEYS, or a key made once in the database), and are scoped by caller and tenant (`callerScope`: reads `request.user` as `{ kind, id, tenantId }`).

- **OpenAPI:** `idempotency.openapi.ts`: `applyIdempotencyMode(document, mode)` makes the published document follow IDEMPOTENCY, `swaggerRequestInterceptor` gives Swagger UI a fresh key per Execute.
- **Order:** its global interceptor must be the outermost: list this module before the usage module and `SharedHttpClientModule` (resilience retries) in `app.module.ts`. A replay then passes through no other interceptor.

Variables (`idempotency.config.ts`): IDEMPOTENCY, IDEMPOTENCY_KEYS.

Always there: core is never removed ([apps/api/AGENTS.md](../../../AGENTS.md), "Folders").
