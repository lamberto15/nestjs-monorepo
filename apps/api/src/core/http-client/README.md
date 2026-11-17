# core/http-client: calling other services

`SharedHttpClientModule` sets the defaults of `@nestjs/http-client` (user-agent = SERVICE_NAME, 10 s timeout, retries of idempotent requests) and of `@nestjs/resilience` (5 s timeout, 3 retries with backoff, circuit breaker: 50% failures over 10 calls, open 30 s). A module registers its client with `HttpClientModule.register({ name, baseUrl })` and injects it (`@InjectHttpClient(name)`); a service creates a policy with `ResilienceService.create()`. A URL a tenant supplies goes through `safeFetch` (core/http) instead, which refuses private addresses.

Order: ResilienceModule's global interceptor retries routes; list this module after `SharedIdempotencyModule` (and usage).

Remove: delete this folder and its line in `app.module.ts`.
