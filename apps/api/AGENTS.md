# AGENTS.md

## NestJS

This app's version of NestJS is likely newer than what you know. https://docs.nestjs.com/llms.txt indexes its documentation, with a markdown page per chapter.

Nest has first-party packages for these, so check them before adding another library or writing your own:

- Databases: [`@nestjs/typeorm`](https://docs.nestjs.com/data/typeorm.md), [`@nestjs/drizzle`](https://docs.nestjs.com/data/drizzle.md), [`@nestjs/mongoose`](https://docs.nestjs.com/data/mongodb.md), [`@nestjs/sequelize`](https://docs.nestjs.com/data/sequelize.md).
- OpenAPI: [`@nestjs/swagger`](https://docs.nestjs.com/openapi/introduction.md). GraphQL: [`@nestjs/graphql`](https://docs.nestjs.com/graphql/quick-start.md). WebSockets: [`@nestjs/websockets`](https://docs.nestjs.com/websockets/gateways.md). Microservices: [`@nestjs/microservices`](https://docs.nestjs.com/microservices/basics.md).
- Sign-in: [`@nestjs/authentication`](https://docs.nestjs.com/security/authentication.md). Permissions: [`@nestjs/authorization`](https://docs.nestjs.com/security/authorization.md). Rate limiting: [`@nestjs/throttler`](https://docs.nestjs.com/security/rate-limiting.md).
- Configuration: [`@nestjs/config`](https://docs.nestjs.com/application/configuration.md). Caching: [`@nestjs/cache-manager`](https://docs.nestjs.com/data/caching.md). Health checks: [`@nestjs/terminus`](https://docs.nestjs.com/reliability/terminus.md). Events inside the app: [`@nestjs/event-emitter`](https://docs.nestjs.com/application/events.md).
- Email: [`@nestjs/mail`](https://docs.nestjs.com/application/mail.md). Files, S3 included: [`@nestjs/storage`](https://docs.nestjs.com/application/file-storage.md). Translations: [`@nestjs/i18n`](https://docs.nestjs.com/application/i18n.md).
- Retries, timeouts and circuit breakers: [`@nestjs/resilience`](https://docs.nestjs.com/reliability/resilience.md).
- Idempotency keys: [`@nestjs/idempotency`](https://docs.nestjs.com/reliability/idempotency.md). Transactional outbox: [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox.md). Sending and receiving webhooks: [`@nestjs/webhooks`](https://docs.nestjs.com/http/webhooks.md).
- Queues: [`@nestjs/bullmq`](https://docs.nestjs.com/application/queues.md). Scheduled jobs: [`@nestjs/schedule`](https://docs.nestjs.com/application/task-scheduling.md).
- Running a scheduled job on one instance, and locks: [`@nestjs/locks`](https://docs.nestjs.com/reliability/locks.md). Processes that take days: [`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows.md).
- Language models, tools and agents: [`@nestjs/ai`](https://docs.nestjs.com/ai/overview.md). MCP servers: [`@nestjs/mcp`](https://docs.nestjs.com/mcp/overview.md).

Validation works with Zod, Valibot, ArkType or any other Standard Schema library, with no classes or decorator metadata: `StandardSchemaValidationPipe` with `@Body({ schema })` or `@Param('id', { schema })` (https://docs.nestjs.com/application/validation.md). `class-validator` still works, through `ValidationPipe`.

`NodeAdapter` from `@nestjs/platform-node` is the fastest HTTP adapter, ahead of Fastify (https://docs.nestjs.com/http/performance.md).

Nest's packages are ESM only, and this project is ESM too: relative imports end in `.js`, `__dirname` doesn't exist (use `import.meta.dirname`), and tests run on Vitest, so mocks are `vi.fn()`, not `jest.fn()`.

## Production data: NestJS Observe

This app's production telemetry - traces, errors, logs and metrics - goes to [NestJS Observe](https://observe.nestjs.com). Until `ObserveModule` is registered in `src/app.module.ts`, nothing is sent: `npx @nestjs/observe link` sets it up in one step - it installs `@nestjs/observe`, wires it into the app, and writes the key pair (`OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`) to `.env`.

When a task depends on how the app behaves in production - an error users hit, a slow endpoint, a failing job, whether a release made things worse - work from that data, not from the code alone:

- The Observe MCP server answers those questions directly: errors with their traces and logs, slow operations, jobs, and what a release changed (`find_regressions`, `diff_release`). It is included on the Pro plan and above. In Claude Code: `claude mcp add observe --transport http https://observe-api.nestjs.com/mcp`, and the client opens a browser to approve. Other clients: https://www.observe.nestjs.com/documentation/mcp
- Without it, the user can open the request or error in the Observe dashboard and click **Copy agent prompt**, which hands over that page's trace, stack and logs as text.

## How this app is built

The root [AGENTS.md](../../AGENTS.md) holds the rules and the owner's decisions. In this app:

- **Folders:** `src/core/<name>` (always there: config, database, tenancy, http, logging…), `src/iam/<name>` (sign-in, access), `src/modules/<name>` (optional capabilities), `src/features/<name>` (business features). Imports go one way: core ← iam ← modules ← features. No `index.ts` barrels.
- **A module's files**, all in its folder: `<name>.module.ts`, `<name>.config.ts`, `<name>.tables.ts`, `<name>.controller.ts`, `<name>.service.ts`, `<name>.schemas.ts` (Zod request and response shapes), `*.spec.ts` (unit), `<name>.e2e-spec.ts` (e2e), `README.md` (what it does, its variables, how to remove it).
- **Environment variables:** only in `<name>.config.ts`: `export const schema = z.object({...})`, then `export const <name>Config = registerAs('<name>', () => { const env = readEnv(schema); return {...}; })` (`core/config/env.ts`). The module imports `ConfigModule.forFeature(<name>Config)`; classes inject `@Inject(<name>Config.KEY) config: ConfigType<typeof <name>Config>`. Nothing else reads `process.env`.
- **Database:** `@InjectDrizzle() private readonly db: Database` (`core/database/database.ts`). Tables live in the module's `*.tables.ts`; `pnpm db:generate` finds them by glob and writes the migration.
- **Columns** come from `core/database/columns.ts`: `uuidPk()` for an id (UUIDv7 from PostgreSQL's `uuidv7()`; no serial ids), `at(name)` for a point in time (`timestamptz(3)`: milliseconds, as a JavaScript Date and a list cursor hold them; never a bare `timestamp()`), `...timestamps()` for created/updated. A calendar day with no time is `date()`. A number people read (INV-0042) is a sequence, never the id.
- **Tenant tables:** every table of a tenant's data is declared with `tenantTable()` (`core/tenancy/tenant-tables.ts`), never `pgTable`. Lead uniques with `t.tenantId`. A key to another tenant table is `tenantReference()`, and the table it points at is declared `{ referenced: true }`. Never filter by tenant or set `tenantId` on insert: the database binds each query to the current tenant. Run work as a tenant with `Tenancy.run(tenantId, work)`, walk tenants with `forEachTenant()`, and use `acrossTenants()` only for whole-table maintenance in workers. Jobs are queued with `withTenant(data)` and consumed with `TenantWorkerHost`.
  ```ts
  export const invoices = tenantTable(
    'invoices',
    {
      id: uuidPk(),
      customerId: uuid('customer_id').notNull(),
      number: text('number').notNull(),
      ...timestamps(),
    },
    (t) => [
      uniqueIndex('invoices_number_idx').on(t.tenantId, t.number),
      tenantReference(
        'invoices_customer_fk',
        [t.tenantId, t.customerId],
        [customers.tenantId, customers.id],
      ),
    ],
  );
  ```
- **Observability** is backend-neutral: `reportError()` and the OpenTelemetry API, never a vendor's SDK in a module (`core/observability/README.md`). A module's own metrics go through `MetricsService` (`core/metrics`).
- **Transactions:** `@InjectTransaction() db: Database` in services, `@Transactional()` on a write that must be atomic; `@InjectDrizzle()` only for what must stay outside a transaction.
- **Sign-in:** every route needs credentials unless it is `@Public()` (`@nestjs/authentication`). `@CurrentUser() user: RequestPrincipal` (`iam/auth/principal.ts`) is who is calling; the request already runs in their tenant. An e2e test gets one with `bootModules(...authModules(), NotesModule)` and `const { headers } = await signedInUser(app)` (`test/auth.ts`).
- **Permissions:** a route declares who may call it, or it is refused: `@Can(NotePolicy, 'read')` (`@nestjs/authorization`), `@Can.Anyone()` for any signed-in principal, `@Public()` for none. A module declares its permissions in its own folder with `definePermissions()` and registers them in its own imports, `AccessModule.forFeature(NOTE_PERMISSIONS)`; its `@Policy()` class asks `AccessService` (`iam/access/README.md` has the sample). A condition is written once, as column and value (`mine: createdBy(notes.createdBy)`, `draft: { where: () => [[notes.status, 'draft']] }`): one record is checked with `access.can(user, 'update', 'Note', note)`, a list is filtered with `await access.sqlFilter(user, 'Note', 'read')`, both derived from it. No action is named `manage`. A job acts through `SystemContext.run(defineSystemJob(...))` with only the permissions it declares. An e2e test boots `...accessModules()` and gets principals from `test/access.ts`.
- **Audit:** `await this.audit.record(user, { action: 'note.deleted', targetType: 'note', targetId: id })` (`iam/audit`), in the transaction of the change.
- **Events:** a module that would import one that already depends on it publishes an event instead (root AGENTS.md, rule 4). Something another module may react to, and that must not be lost, is published in the transaction of the change: `events.publish(noteCreated, payload)` with `export const noteCreated = defineEvent<{ id: string }>('note.created')` (`core/outbox/events.ts`); a subscriber marks a method `@OnDomainEvent(noteCreated, { consumer: 'search' })` and runs in the event's tenant, in the worker. `@nestjs/event-emitter` is for reactions inside the same request only.
- **Long work** is a job on a queue the module registers itself (`core/queues`, `withTenant(data)`), or a workflow when it has steps that wait (`core/workflows`, `TenantWorkflow`).
- **Retries of a write:** `@IdempotentRoute()` on a route that creates or acts (`core/idempotency`). **Outbound HTTP:** `HttpClientModule.register({ name, baseUrl })` in the module's imports (`core/http-client`: timeouts, retries, circuit breaking); `safeFetch` for a URL a tenant supplied.
- **A key the app makes for itself** (not given in the environment) is made once and kept in the database: `secrets.loadOrCreate('NAME', generate)` (`core/secrets`), so every instance shares it.
- **Records:** a feature is a record: nine files written by the generator, on the engine in `modules/records` (its README is the contract: "Writing a feature"). What a record can also have (tags, comments, a number…) is an add-on: a module with `XModule.forRecord(DECLARATION)`, listed in the feature module's own imports; it adds routes with `@RecordController()` and joins the record's writes and views through one `@RecordExtension()` provider ("Writing an add-on", "Testing an add-on").
- **Readiness:** a module that owns a dependency marks a provider `@ReadinessCheck('name')` (`core/health/readiness.ts`); `GET /health` finds it.
- **Errors** are thrown as Nest HTTP exceptions with a `code`; an error class of a package maps with `ProblemDetailsFilter.map()` in the module's own folder.
- **Wiring:** a module is added to `src/app.module.ts` and nowhere else. If a module seems to need a line in another module's file, it needs an event or a discovery decorator instead.
- **e2e tests** boot the module under test with what it imports, not `AppModule` (`bootModules()`, `test/boot.ts`), and drive it with `app.inject()`; each file runs on its own copy of a migrated database: a module that can't be tested alone isn't self-contained.
- **Comments** say why, in a sentence or two. No commented-out code.
