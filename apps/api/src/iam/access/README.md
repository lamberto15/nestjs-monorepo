# iam/access

Who may do what. Roles of permissions (an action on a subject, with
conditions and optional fields) that administrators edit through the access
API; routes and services check them through @nestjs/authorization
(`@Can()`, `AuthorizationService.authorize()`), whose policies ask
AccessService. CASL runs in one file, `access.service.ts`.

## In a module

Declare the module's permissions next to its code and register them in its
own imports. Texts go in the module's `i18n/<locale>.json` under
`permissions.<subject in kebab case>`.

```ts
// notes.permissions.ts
export const NOTE_PERMISSIONS = definePermissions({
  subjects: {
    Note: {
      actions: { read: ['mine', 'inMyUnits'], update: ['mine'], create: [] },
      conditions: {
        mine: createdBy(notes.createdBy),
        inMyUnits: inMyUnits(notes.unitId), // iam/organization/unit-conditions.ts
        draft: { where: () => [[notes.status, 'draft']] },
      },
      fields: { body: { sensitive: true } },
    },
  },
  seedRoles: [{ key: 'editor', permissions: [{ subject: 'Note', action: 'create', conditions: [] }] }],
});

// notes.policy.ts
@Policy()
export class NotePolicy {
  constructor(private readonly access: AccessService) {}
  read(user: Principal | null, note?: Note) {
    return this.access.can(user, 'read', 'Note', note);
  }
}

// notes.module.ts
@Module({ imports: [AccessModule.forFeature(NOTE_PERMISSIONS)], providers: [NotePolicy, …] })
```

- **A condition is written once**, as column/value data: `where()` returns
  `[column, value | values]` pairs that must all hold (an empty list or
  `undefined` matches nothing). The CASL condition of one record and the
  SQL filter of a list are both derived from it.
- **One record:** `access.can(principal, action, subject, row)`. **A list:**
  `and(list.where(q), await access.sqlFilter(principal, subject, action))`.
- **Fields:** `redact()`, `redactAll()`, `forbiddenFields()`,
  `assertQueryFields()` (403 `field_forbidden`).
- **Soft delete:** `deletedAt` on the subject: a deleted record can only be
  restored; `sqlFilter(…, { deleted: true })` for the recycle bin.
- **After a change to grants or units**, `access.invalidate()` (every
  instance, Redis pub/sub). Abilities are cached for a minute at most,
  never past a grant's end or a unit membership's start or end.

## The system principal

Work without a user runs through `SystemContext.run(JOB, work, { tenantId })`
as `system:<key>`, with only the permissions its `defineSystemJob()`
declares (listed in `systemJobs` of a `forFeature()` declaration).

## Extending it (no registry)

- `@UnitDirectory()`: the provider that tells access a user's units
  (iam/organization). Without one, nobody is in a unit.
- `@AccessRecordFinder('Note')`: finds a record for the explanation route
  (`?recordId=`), as its asker may read it.
- Events (`access.events.ts`): `access.member-deactivated`.

## Tests

`test/access.ts`: `accessModules()`, `member(app, tenantId, ['editor'])`,
`tenantWithAdmin(app)`, `seededAdmin(app)`, `roleIds()`.
