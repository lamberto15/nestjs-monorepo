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

## Break-glass

A principal with `breakGlass` set (an operator reading another tenant,
iam/break-glass) holds every action of the catalog
(`catalog.breakGlassPermissions()`), unconditional, whatever its roles, so it
reads every route an administrator may read; only in the grant's tenant, in
its read-only scope (GET, HEAD and OPTIONS; READ ONLY transactions), so
nothing is written.

## Extending it (no registry)

- `@UnitDirectory()`: the provider that tells access a user's units
  (iam/organization). Without one, nobody is in a unit.
- `@ScimMembers()`: the provider that tells which members the tenant's IdP
  provisions (iam/sso): the users routes show `managedByScim`. Without
  one, nobody is.
- `@MemberAvatars()`: the provider that gives the members' pictures
  (modules/attachments/avatars): the users routes show `avatarUrl`.
  Without one, nobody has one (null).
- `@AccessRecordFinder('Note')`: finds a record for the explanation route
  (`?recordId=`), as its asker may read it.
- Events (`access.events.ts`): `access.member-deactivated` (its actor an
  administrator or SCIM's API client), `access.member-reactivated` (iam/sso
  reactivates an account its deprovisioning deactivated),
  `access.abilities-changed` (no payload, `emit()` on every instance when
  `invalidate()` drops the cache there: modules/realtime re-checks its
  impersonation sockets).
- `GET /v1/access/roles` and `GET /v1/access/users` also answer whoever
  holds `Access.manageSso` (`openForSso`: the SSO page's pickers).

## Who holds what

`MembersService` answers for other modules: `active(ids)`, `withRole(role, among?)` (the active members holding a role, by key or id) and `permitted(action, subject, record)` (the active members who may do it to that record). modules/approvals resolves its approvers with them.

## Tests

`test/access.ts`: `accessModules()`, `member(app, tenantId, ['editor'])`,
`tenantWithAdmin(app)`, `seededAdmin(app)`, `roleIds()`.
