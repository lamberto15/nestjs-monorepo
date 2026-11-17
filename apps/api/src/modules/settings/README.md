# modules/settings

Settings and feature flags: typed values with defaults in code, that
administrators change at runtime for the tenant, a unit or a person, that
users set for themselves (preferences), and that the deployment's operators
set for every tenant at once. A feature flag is a boolean setting that can
also roll out to a share of principals or switch by rule.

## In a module

Declare the settings next to the code, register them in the module's own
imports, read them where needed. The catalog (`GET /v1/settings`) is what
was registered; no central list exists.

```ts
// notes.settings.ts
export const NOTE_PUBLISH_DELAY = setting({ key: 'notes.publishDelay', label: 'Publication delay', schema: duration, default: '10s' });
export const NOTE_RICH_TEXT = flag({ key: 'notes.richText', label: 'Rich text editor', default: false });
export const NOTE_SETTINGS = defineSettings([NOTE_PUBLISH_DELAY, NOTE_RICH_TEXT]);

// notes.module.ts
@Module({ imports: [SettingsModule.forFeature(NOTE_SETTINGS)], … })

// a service
const delay = await this.settings.get(NOTE_PUBLISH_DELAY);       // for the tenant
const rich = await this.settings.enabled(NOTE_RICH_TEXT, user);  // for this principal

// a route that exists only while a flag is on for the caller (404 otherwise)
@Get('beta') @Can.Anyone() @RequireFlag(NOTE_BETA) beta() {}
```

- `key`: dotted, the module first. `schema`: a Zod type the value must pass
  (the default is checked at start). `scopes`: where it may be set, `['tenant']`
  by default; add `unit` and/or `user` (a preference); `[]` for a value only
  the operators set. `public: false` hides it from callers who may not read
  settings. `flag()` is a boolean with every scope and a rollout.
- **Flags are settings**, not a second registry: one catalog, one route set,
  one cache. `@RequireFlag()` is the guard; the module of the route imports
  `SettingsModule.forFeature()` (it provides the guard).
- **A secret** (`secret: true`, a string): stored encrypted
  (core/encryption, `DATA_ENCRYPTION_KEYS` required: the app refuses to start
  without it), never shown by the API (`value: null`, `source` says whether one is
  set) and left out of the audit log; `settings.get()` returns it. Key rotation
  of these two columns is not automatic: set the value again.
- `settings.restrict(DECL, check)` puts a deployment ceiling on values (400
  `setting_not_allowed`); `settings.guardWrite(DECL, check)` refuses a write by a
  caller (409 with your `code`), e.g. one that would lock the writer out;
  `settings.anyOn(FLAG, principal)` is "true at any scope" for policies whose
  `true` is the strict side. In a workflow, read a setting inside a step so a
  replay sees the value the instance started with.

## Precedence

For a principal: the operators' **enforced** platform value, their own value,
one of their units' values, the tenant's targeting rules, the tenant's value,
the tenant's rollout, the operators' platform rules, their platform value
(or rollout), the default. `settings.resolve()` also says which (`source`).
Every stored value is a tenant's (`setting_overrides`, row-level security);
outside a tenant a setting is its platform value or default. A rollout draws
`sha256(key:tenantId:principalKey)`: stable, never switching anyone off as it
grows, drawn apart in each tenant.

Targeting rules (flags): an ordered list of conditions (`principalKind`, `role`,
`emailDomain`, `locale`, `tenantSlug`, `tenantOperator`) and an outcome; the
first rule that holds decides; a condition that cannot be evaluated does not
hold (fails closed). `settings.rules.ts`.

## Routes

- `GET /v1/settings`, `GET /v1/settings/{key}`: your value, its `source`, what the
  value takes (`type`, `options`, bounds, JSON Schema, from the Zod schema), what
  you may do (`canEdit`, `canSetMine`, `canEditPlatform`). Anyone.
- `PUT`/`DELETE /v1/settings/{key}/mine`: your preference (`user` scope). Anyone.
- `PUT`/`DELETE /v1/settings/{key}`, `GET /v1/settings/{key}/overrides`:
  `Setting.update` / `Setting.read` (users, not while impersonating).
- `PUT`/`DELETE /v1/settings/{key}/platform`: `Setting.update` in the operators'
  tenant (`@OperatorOnly()`): `{ value?, enforced?, rollout?, rules? }`. Kept
  working in maintenance mode so operators can end it.
- Every change is audited (`setting.updated`, `setting.reset`, with from and to).

## How it works

`SettingsCache` keeps each tenant's overrides (and the platform values) in
memory per instance, for a minute at most. A change calls `invalidate()` after
its commit: this instance forgets at once, the others on a Redis pub/sub
message (the approach of `AccessService.invalidate()`; a shared helper is worth
it when a third module needs it). A read never waits for Redis.

## Variables

None. Needs DatabaseModule, TenancyModule, RedisModule, EncryptionModule,
AuditModule and what AccessModule needs.

## Removing it

Delete the folder and its line in `app.module.ts`, and the
`SettingsModule.forFeature()` of every module that declares settings (and
`modules/mode`, which stands on it).
