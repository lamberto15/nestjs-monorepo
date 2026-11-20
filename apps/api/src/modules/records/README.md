# Records

The records engine. A feature declares its record once (`<item>.record.ts`)
and derives its table, schemas, list, permissions, policy, store and
presenter from it with this module's functions, called in the feature's own
files. A feature registers itself with `RecordsModule.forFeature()`; no
central file lists features. Add-ons (tags, comments, sequences…) join a
record through the extension contract below; the engine knows no add-on.

Reference: `test/fixtures/test-items` (the files below, in order), tested
by `test-items.e2e-spec.ts` and `two-apps.e2e-spec.ts`.

## Writing a feature

1. **`<item>.record.ts`**: `defineRecord({ subject, path, noun, table, softDelete, recycleBinDays, unit, clientAccess, grants, idempotency, apiTag, views, readThrough, fields })`.
   Fields come from `field.*` (modules/fields): `.searchable()`, `.unique()`,
   `.optional()`, `.readOnly()` (set by the service only; a body's value is
   dropped, as unknown keys are). A reference:
   `parentId: field.ref((): Referenced => recordTableOf(ITEM)).optional()`
   (`.onDelete('keep')` for an optional one that stays while its record is in the bin).
   `readThrough: 'accountId'`: a child read through its parent (a log of
   activities on an account), by whoever may read the parent, at a route the
   feature writes under the parent's, `GET /v1/<parents>/:id/<path>`
   (`limit`, `cursor`; `{ items, nextCursor }`, newest first). The parent's
   related panel lists it there, with its columns, and the app does not
   start without that route (the fixture: `test/fixtures/notes`).
2. **`<item>s.tables.ts`**: `export const items = recordTable(ITEM, { columns: numberColumns() })`:
   id, ownerId, unitId (with `unit`), the fields, the add-ons' `columns`,
   timestamps, deletedAt/deletedBy (with `softDelete`), the search vector
   (with searchable fields), the tenant wall. `extras` adds indexes.
3. **`<item>.schemas.ts`**: `recordSchemas(ITEM, { body: NUMBER_BODY, response: NUMBER_RESPONSE })`:
   create, update (partial) and response; `body` and `response` are what the
   record's add-ons read from the bodies and show (their exported shapes, spread together).
4. **`<item>.list.ts`**: `recordList(ITEM, items)`: every field's filters and
   sorts (a reference: `?parentId=`), `q`/`rank`, ownerId, unitId,
   createdAt, updatedAt, `fields=`, `deleted=true`.
5. **`<item>.permissions.ts`**: `recordPermissions(ITEM, items, { fields })`:
   read/create/update/delete/restore, conditions `mine` and the units', the
   API clients' own records (`clientAccess: 'own'`), the seed roles' grants
   (editor: their own; unit-lead: their units'; viewer: all).
6. **`<item>.policy.ts`**: `@Policy() export class ItemPolicy extends RecordPolicy {}`.
   An ability of the feature's own goes here.
7. **`<item>s.service.ts`**: injects `RecordStore<Item>`; business logic around
   `create(owner, values, { input: dto })`, `findOne`, `findPage`,
   `update(by, id, changes, { check, input: dto })`, `delete(by, id, { check })`.
   `input` is the validated body: the add-ons' hooks read their keys from it.
   Logic that must hold for every write (a derived read-only column) is not
   here: bulk, imports, automations, a restored revision and a recurring
   create write through the store, not the service. Put it in the feature's
   own `@RecordExtension()` provider (`creating`/`updating` return the
   columns), listed in the feature module's providers: the fixture's
   `test-item.logic.ts` counts `words` this way.
8. **`<item>s.controller.ts`**: HTTP only. POST (`@Can(Policy,'create')`,
   `@RecordIdempotent`, `assertWritableFields`), GET list
   (`presenter.query`/`page`, `IncludePipe`), GET one, PATCH, DELETE
   (`@Can.Anyone()`, then `findOne(id, { visibleTo })`: a 404 for a record the
   caller may not read; the policy and `assertUnchanged` (If-Match, 412)
   in `check`, on the locked row). `@Etag()` on every read.
9. **`<item>s.module.ts`**:

   ```ts
   imports: [
     AccessModule.forFeature(ITEM_PERMISSIONS),
     RecordsModule.forFeature(ITEM, { table: items, list: ITEM_LIST, schemas: ITEM_SCHEMAS, policy: ItemPolicy }),
     TagsModule.forRecord(ITEM), // each add-on: one import
   ],
   controllers: [ItemsController],
   providers: [ItemsService, ItemPolicy],
   ```

   `forFeature` provides the store, the presenter, `IncludePipe`, the
   declaration as `RECORD`, `POST /<path>/{id}/restore` (with `softDelete`),
   the access explanation's record finder, and the registration lists,
   search and add-ons read. `quota: { label, default? }` limits the live
   records per tenant (modules/quotas, 422 `quota_exceeded`); off without it.

What every record gets from the engine, in the write's transaction:

- audit `<item>.created|updated|deleted|restored` (an update's changes
  field by field, sensitive ones redacted), `records.purged`;
- domain events `<item>.created|updated|deleted|restored` (`recordEvents(ITEM)`,
  core/outbox), payload `{ subject, id, by, record }`;
- 409 `<item>_taken` for a unique value taken (on create, update, restore);
- 409 `legal_hold` on a delete of a held record (iam/holds);
- relations: 422 `reference_not_found` (a reference to a record that is
  missing, in the bin or unreadable), 409 `record_referenced` (deleting
  one live records refer to), 409 `reference_deleted` (restoring one whose
  reference is in the bin), optional references emptied when their record
  is purged; `?include=parent` (`{ id, title }`, null when unreadable);
  `related` in GET /v1/lists/{subject};
- titles (`RecordTitles`): a record is called by its first string field,
  after its parent's title when it has a parent: the reference one of its
  fields is `unique({ within })` (`recordParentField()`). Two "Standard plan"
  products of two companies read "Acme · Standard plan" and "Globex · Standard plan",
  their statuses "Acme · Standard plan · Open". Pickers, list cells, filter chips
  (GET /v1/lists/{subject}/options) and `?include=` show the same title; a
  search matches the record's own title; a parent the caller may not read
  is left out of it;
- the recycle bin's purge (`RecycleBinPurgeJob`, 03:45 UTC): records deleted
  longer ago than `recycleBinDays` (default SOFT_DELETE_RETENTION_DAYS, 30)
  go for good, never held ones.

Responses: the API's view (no tenant, no vector), what add-ons show, less
the fields the caller may not read; `?include=can` adds
`can.update|delete|restore`, outside the ETag.

## Writing an add-on

An add-on is a Nest module with a `forRecord(DECL)` dynamic module. The
feature opts in by importing it: the import is the only switch (a list of
capability names in the declaration would be a second one, which the engine
would have to interpret). The declaration stays the single source: the
add-on reads the record's subject, path, table and policy from it and from
`Records`; what must exist before Nest starts (columns, body and response
schemas) the add-on exports and the feature passes to `recordTable()` and
`recordSchemas()`, one argument each.

The contract:

- **Routes** under `/v1/<path>/:id/<addon>`: `@RecordController(record, ':id/<addon>', '<Suffix>')`
  (tag, security schemes, the name `<Subject><Suffix>Controller`; two of one
  name fail the app's start). Each handler is `@Can.Anyone()`, then
  `records.of(subject).store.findOne(id, { visibleTo: user })` (a 404) and
  `authorization.authorize(feature.policy, '<action>', user, row)` (a 403).
- **Hooks**, on one provider marked `@RecordExtension()` implementing
  `RecordHooks`, all in the write's transaction (query through
  `@InjectTransaction()`; throwing refuses the write and rolls it back):
  `creating({ values, owner, by, input })` and `updating({ before, changes, by, input })`
  before the row is written, returning column values to merge (or nothing);
  `created`, `updated`, `deleting` (before a delete: a refusal is a 409),
  `deleted`, `restored` after; `purged({ ids })` before records go for good
  (a delete without bin, the bin's purge, a retention rule: never use
  `@RecordPurge()` yourself); `merged({ from, to, by })` in a merge's
  transaction (modules/merge calls `store.merged()` after the survivor's
  update): move what the add-on keeps about the duplicate `from` to the
  survivor `to`. `input` is the request's validated body.
- **Columns** on the record's table: export `numberColumns = () => ({ number: text('number') })`;
  the feature writes `recordTable(ITEM, { columns: numberColumns() })`.
- **Body keys**: export `NUMBER_BODY = { namingSeriesId: z.uuid() }`; the feature
  writes `recordSchemas(ITEM, { body: NUMBER_BODY })` (each optional, on
  create and update); hooks read `input.namingSeriesId`.
- **Presenter**: `shows` (keys `fields=` may pick) and `present(principal, views)`
  (one query for a page), before field-level redaction; export the response
  shape for `recordSchemas(ITEM, { response })`.
- **`include=`**: `include: { name, values(principal, ids) }`, outside the ETag.
- **List**: `filters(table)` (FilterFields, `?tag=`), merged into the list at startup;
  `listFields(principal)` (`{ fields, select? }`, the tenant's `custom.<key>`),
  asked on each list query (`presenter.query`) and list description, merged
  into the list for that request (`registration.listFor(principal)`);
  `capability` (`capabilities.<name>` in GET /v1/lists/{subject}), `available()`
  (a deployment switch), `describe(principal)` (top-level keys: `attachmentLimits`).
- **Domain events**: `@OnDomainEvent(recordEvents(record).created, { consumer })`,
  delivered after the commit.
- **The ETag rule**: what an add-on shows (`present`) changes only in a write
  (the record's, through its hooks, or the add-on's own route), never in a
  subscriber or a job; anything else goes through `include=`.

Which hook each kind of add-on uses:

| Add-on                                | Hooks                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| sequences, numbering                  | `creating` returns `{ number }` (a column)                                                    |
| computed fields                       | `present` computes them on each read (not stored), `shows`                                    |
| custom fields                         | `created`, `updating` validate `input.custom` and store it; `present`, `listFields`, `purged` |
| approvals                             | `updating` (and `deleting`) throw while one is pending                                        |
| tags, comments, attachments, watchers | routes, `present`, `filters`, `deleting`/`purged`, `merged` (and favorites)                   |
| revisions                             | `created`, `updated`, `restored` write a snapshot; `purged`                                   |
| webhooks, automations, notifications  | `@OnDomainEvent` on `recordEvents()`                                                          |

A complete add-on (the fixture's proof, `test/fixtures/test-items/marks`):

```ts
@RecordExtension()
@Injectable()
export class MarksExtension implements RecordHooks {
  readonly shows = ['marks'];
  readonly capability = 'marks';
  readonly include = {
    name: 'marked',
    values: async (_p: Principal, ids: string[]) =>
      new Map(
        [...(await this.marks.of(this.record.subject, ids))].map(([id, m]) => [
          id,
          m.length > 0,
        ]),
      ),
  };

  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly marks: MarksService, // @InjectTransaction() inside
  ) {}

  async present(_p: Principal, views: Record<string, unknown>[]) {
    const marks = await this.marks.of(
      this.record.subject,
      views.map((v) => v.id as string),
    );
    return views.map((v) => ({ ...v, marks: marks.get(v.id as string) ?? [] }));
  }

  filters(table: RecordTable): Record<string, FilterField> {
    return {
      mark: {
        column: table.id,
        type: 'string',
        ops: ['eq'],
        conditions: {
          eq: (value) =>
            inArray(
              table.id,
              this.marks.idsWith(this.record.subject, String(value)),
            ),
        },
      },
    };
  }

  // Before the insert: a column of its own (markColumns()), from a body key (MARKS_BODY).
  async creating({ input }: { input: Record<string, unknown> }) {
    return { lastMark: (input.marks as string[] | undefined)?.at(-1) ?? null };
  }

  async created({ row, input }: RecordChange) {
    if (input.marks)
      await this.marks.set(
        this.record.subject,
        row.id,
        input.marks as string[],
      );
  }

  // Before the update, on the locked row: a refusal.
  async updating({ before }: { before: RecordRow }) {
    if (
      (await this.marks.of(this.record.subject, [before.id]))
        .get(before.id)
        ?.includes('frozen')
    ) {
      throw new ConflictException({
        code: 'record_frozen',
        message: 'Remove its "frozen" mark first.',
      });
    }
  }

  async deleting({ row }: RecordChange) {
    if (
      (await this.marks.of(this.record.subject, [row.id]))
        .get(row.id)
        ?.includes('locked')
    ) {
      throw new ConflictException({
        code: 'record_locked',
        message: 'Remove its "locked" mark first.',
      });
    }
  }

  async purged({ ids }: { ids: readonly string[] }) {
    await this.marks.forget(this.record.subject, ids);
  }

  async describe() {
    return { markLimit: 10 };
  }
}

@Module({})
export class MarksModule {
  static forRecord(record: RecordDeclaration): DynamicModule {
    @RecordController(record, ':id/marks', 'Marks')
    class MarksRoutes {
      constructor(
        private readonly records: Records,
        private readonly marks: MarksService,
        private readonly authorization: AuthorizationService,
      ) {}

      @Put()
      @Can.Anyone() // Checked below: changing the record.
      async set(
        @CurrentUser() user: Principal,
        @Param('id', ParseUUIDPipe) id: string,
        @Body({ schema: setMarksSchema }) body: { marks: string[] },
      ) {
        const { store, feature } = this.records.of(record.subject);
        const row = await store.findOne(id, { visibleTo: user });
        await this.authorization.authorize(feature.policy, 'update', user, row);
        return { items: await this.marks.set(record.subject, id, body.marks) };
      }
    }

    @Injectable()
    class Seen {
      constructor(private readonly marks: MarksService) {}
      // After the commit: its own table, not what the record shows (the ETag rule).
      @OnDomainEvent(recordEvents(record).created, {
        consumer: `marks-${record.path}`,
      })
      async created({ subject, id }: RecordEventPayload) {
        await this.marks.seen(subject, id);
      }
    }

    return {
      module: MarksModule,
      imports: [RecordsModule],
      controllers: [MarksRoutes],
      providers: [
        { provide: RECORD, useValue: record },
        MarksService,
        MarksExtension,
        Seen,
      ],
    };
  }
}
```

Classes declared inside `forRecord()` are one per record; name one that has
no decorator naming it (`Object.defineProperty(cls, 'name', …)`).

## Testing an add-on

Test on the fixture's test items (`test/fixtures/test-items`), never with
record tables of your own and without editing the fixture:
`testItemsModule({ imports, response, body, quota })` builds the test items'
module with your add-on; `test/records.ts` has the rest.

```ts
vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
});
let app: NestNodeApplication;
let team: Awaited<ReturnType<typeof recordsTenant>>; // admin, editor, other, viewer, nobody
beforeAll(async () => {
  app = await bootModules(
    ...testItemModules(),
    testItemsModule({
      imports: [TagsModule.forRecord(TEST_ITEM)],
      response: TAGS_RESPONSE,
      body: TAGS_BODY,
    }),
  );
  team = await recordsTenant(app);
});
it('tags a record', async () => {
  const item = await createTestItem(app, team.editor.headers, {
    title: 'Tagged',
  });
  // … PUT /v1/test-items/{id}/tags, then GET it as team.viewer …
});
```

- `testItemModules()`: access, idempotency, outbox, lists and search modules.
- `recordsTenant(app)`: a tenant and its members `admin`, `editor`, `other`
  (an editor: each their own records), `viewer` (reads all), `nobody`.
- `unitWithLead(app, team)`: `{ unitId, worker, lead }`, an editor in a unit
  and its `unit-lead`.
- `createTestItem(app, headers, body?)`: a record of the caller's (201 or it throws).
- Test items have: `title` (searchable), `body` (searchable, a field-level
  grant), `publishedAt`, `code` (unique), `status` (`draft|done`), `words`
  (read-only), `parentId` and `linkedId` (references to test items), a
  recycle bin and units. The marks add-on's `lastMark` column is on the
  table; a column your add-on needs that the table lacks is a change to the
  fixture: ask for it.
- The recycle bin's purge: `app.get(RecycleBinPurgeJob).run()` after setting
  `deletedAt` in the past.
