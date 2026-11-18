# modules/mcp

An MCP server (Model Context Protocol) in the API, on `@nestjs/mcp`: an AI
agent acts in the app as one principal, an API client or a user, with
exactly its permissions. Its tools are provider methods of the modules that
own the logic, found at startup; no list names them.

## The endpoint

`POST /v1/mcp`, Streamable HTTP, stateless (no session; every message is a
request of its own; GET and DELETE answer 405). Clients of the 2026-07-28
and the 2025 protocol revisions are served.

- **Credentials:** an API key or a user token as a bearer
  (`Authorization: Bearer …`). The session cookie is refused, alone or next
  to a bearer (401 `mcp_bearer_required`): a browser sends it on its own,
  so a page of another site could act as the user (CSRF), and a call is
  then always the bearer's principal. A page on another site is also
  refused by the package's `Origin` check (403; only localhost pages pass).
- **A route like every other:** the rate limit, the principal and its
  tenant, MFA enrollment, onboarding, "SSO required", break-glass, the
  deployment mode, usage metering (an API client's message counts as
  `POST /v1/mcp`). In maintenance the endpoint is refused (503
  `maintenance`); in read-only mode it is let through
  (`@ReadOnlyPerCall()`, modules/mode) and the mode's guard decides each
  call by its tool's `annotations.readOnlyHint`: a tool declaring it runs,
  every other is refused (503 `read_only`), as the HTTP API serves reads
  and refuses writes. A `Break-Glass` request is refused (403).
- **Each tool call** runs through the global guards again, as `'mcp'`
  calls: `@Can()` on the tool decides it. Every principal is shown every
  tool (`tools/list`: the package builds one list for all); a call the
  principal may not make is a tool error.
- **Errors** are tool results with `isError: true` whose text (and
  `structuredContent`) is the API's problem: `{ status, code, message,
errors? }`, the same `code` as the HTTP twin (`forbidden`, `not_found`,
  `validation_failed`, `quota_exceeded`…). Arguments the tool's schema
  refuses are answered by the SDK before the tool runs, as text
  (`Input validation error: …`).

## Connecting a client

Make an API client and its key (`/v1/access/clients`, iam/api-clients; the
key is shown once) with the roles the agent may use, then:

- **Claude Code:** `claude mcp add --transport http app https://<host>/v1/mcp --header "Authorization: Bearer <key>"`
- **MCP Inspector:** `npx @modelcontextprotocol/inspector`, transport
  Streamable HTTP, URL `http://localhost:3000/v1/mcp`, header
  `Authorization: Bearer <key>`.

A user's access token works the same way, as that user in the token's tenant.

## Tools

- `whoami`: the principal, its tenant and its permissions.
- `describe_list { subject }`: a list's fields, filters, operators, sorts
  and views (GET /v1/lists/{subject}).
- `search { q, subject?, limit? }`: the global search (GET /v1/search).
- For each record that imports `McpModule.forRecord()`: `<path>_list`
  (every query parameter of GET /v1/<path> as an argument: flat filters such
  as `title.contains`, `filter` as JSON, `q`, `sort`, `limit`, `cursor`,
  `fields`, `deleted`), `<path>_get { id }`,
  `<path>_create { …fields, idempotencyKey? }`,
  `<path>_update { id, changes, ifMatch? }`, `<path>_delete { id, ifMatch? }`.

The record tools take the HTTP routes' path: the record's store and
presenter (the add-ons' hooks, quotas, references, legal holds, the audit
entry and the domain event of each write), the policy on the row,
field-level permissions, a record the caller may not read is a 404, and the
answer is what the route answers (no tenant, no hidden field). No tool is
looser than its route:

- `_get`, `_create` and `_update` answer `{ etag, record }`, the etag
  the route sends; `_update` and `_delete` take it as `ifMatch`, the
  route's `If-Match` (optional, as there; a stale one is a 412
  `precondition_failed`).
- `_create` takes an `idempotencyKey` when POST takes an
  `Idempotency-Key` (the record's `idempotency`, else IDEMPOTENCY), and
  requires it when POST does. A retry with the key answers the record the
  first call created (as it is now: only its id is kept), the key with
  other arguments is a 422 `IDEMPOTENCY_KEY_REUSED`, a call still running a
  409 `IDEMPOTENCY_KEY_IN_USE`; a refused call frees the key. Per caller, in
  core/idempotency's store.
- The write arguments are the feature's own schemas (`forFeature({ schemas })`,
  kept on RecordFeature), so the keys its add-ons read from a body (marks,
  custom fields, a naming series) are taken. The list's are its list.
- Every tool declares `readOnlyHint` truthfully (read-only mode follows it).

## In a record's module

```ts
imports: [McpModule.forRecord(INVOICE)];
```

## A tool of a module

In the module that owns the logic, on a provider of its own:

```ts
@McpTools()
@Injectable()
export class InvoiceTools {
  constructor(private readonly invoices: InvoicesService) {}

  @Tool({
    name: 'invoices_send',
    description: 'Sends an invoice to its customer by email.',
    inputSchema: z.object({ id: z.uuid() }),
  })
  @Can(InvoicePolicy, 'send')
  send(
    { id }: { id: string },
    _context: McpContext,
    @CurrentUser() user: RequestPrincipal,
  ) {
    return this.invoices.send(user, id);
  }
}
```

- `@Can(Policy, 'ability')` or `@Can.Anyone()` (then check in the method,
  as a route does) on every tool; `@McpTools()` on its class (problem
  errors). Declare `annotations: { readOnlyHint: true }` only on a tool
  that changes nothing: read-only mode lets it run. The boot fails on a tool
  without a check or `@McpTools()`, and on a read-only one whose `@Can()`
  asks for create, update, delete or restore (McpToolChecks). The packages'
  metadata keys it reads are checked against the installed decorators
  (mcp-tools.spec.ts).
- The same method can be an agent function of `@nestjs/ai` too, with
  `@AgentFunction()` stacked on it.
- Texts the model reads (descriptions) are written for it: what the tool
  does, when to use it, what changes.

No resources or prompts: nothing here is content a client loads as it is,
and tools cover lookups. Not here: per-principal tool lists, stdio.

Remove: delete this folder, its line in `app.module.ts` and the
`McpModule.forRecord()` imports.
