# modules/ai

Asks a language model about a record (summarize it, classify it) and keeps a
structured answer. Built on `@nestjs/ai` over `@ai-sdk/anthropic`. Off
unless `ANTHROPIC_API_KEY` is set, then off for a tenant until an
administrator sets `ai.enabled` (operators can force it off for every
tenant with an enforced platform value). Tests use `FakeModel`
(`@nestjs/ai/testing`), never the network.

## In a record's module

```ts
imports: [AiModule.forRecord(NOTE)];
```

The request names the record by its collection path (`source: 'notes'`).

## Routes

- `POST /v1/ai/runs { source, recordId, task }`: 202 `{ id, status: 'queued' }`.
  `task` is `summarize` or `classify`. Whoever may read the record; 20 a
  minute per user. 403 `ai_disabled`, 404 (unknown source, unreadable
  record), 409 `ai_pending`, 429 `ai_quota_exceeded` (with `quota` and `retryAfter`, as modules/quotas), 503 `ai_unavailable`.
- `GET /v1/ai/runs/{id}`: the run (`status`, `model`, `promptVersion`,
  tokens, `cached`, `error`, `errorCode`, `output` for an hour); only its requester.

A worker (queue `ai`) checks the requester again, reads the record as they
may read it (field-level access applied), asks the model with the task's
Zod schema and validates the answer itself. The requester hears `ai.ready`
or `ai.failed` over realtime. Audited: `ai.requested`, `ai.completed`,
`ai.failed`. `ai_runs` is a usage record: no prompt, no output.

## Quota and cache

Tokens count against the quota `ai.tokensPerDay` (modules/quotas, default
500 000 a day per tenant; operators change it per tenant or plan). Checked
when a run is asked for, counted when it ends. An identical prompt is
answered from Redis for `AI_CACHE_TTL_SECONDS` (no tokens).

## Variables (`ai.config.ts`)

ANTHROPIC_API_KEY, AI_BASE_URL, AI_MODEL (default `claude-sonnet-5-5`),
AI_MODEL_CHEAP (default `claude-haiku-5-5`), AI_TIMEOUT_MS,
AI_MAX_OUTPUT_TOKENS, AI_ATTEMPTS, AI_CACHE_TTL_SECONDS.

Prompts and completions are declared to log redaction. A task is added in
`ai.tasks.ts` with its version, tier, prompt and schema.

Remove: delete this folder and its line in `app.module.ts`, and the
`AiModule.forRecord()` imports.
