# Adding a feature

A feature is a business record (invoices, tickets, customers): its routes,
permissions, table, tests and the add-ons it takes, and its web pages. It
lives in one folder, `apps/api/src/features/<name>/`, and one line of
`src/app.module.ts`; its pages in `apps/web/src`. The
template ships **no sample feature**: `src/features` starts empty.

Features come from a generator, the `feature` schematic of the local Nest
schematics collection in `apps/api/schematics` (plain ESM factories, no build
step). It writes a feature in the shape of the records engine
(`src/modules/records/README.md`, "Writing a feature"); you then write only
the business logic.

## Generate one

From `apps/api`, interactively (Nest's CLI asks for the fields, the add-ons,
the recycle bin and the units):

```bash
./node_modules/.bin/nest g -c ./schematics/collection.json feature invoices
```

From the repository's root, with every option on the command line, the API's
files and the web pages in one run (`tools/feature-add.mjs`: the schematics
CLI Nest uses underneath, from the root with `--web-root apps/web/src`, then
the router's route tree). `nest g` from `apps/api`, and `pnpm feature:add`
there, write the API's files only:

```bash
pnpm feature:add invoices --fields "title:string,amount:money,dueOn:date?,status:enum(draft|sent|paid)" --addons tags,comments,sequences
```

| Option                              | Does                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>`                            | Plural, kebab-case: `invoices`, `invoice-lines`. `--singular` when it can't be derived (`people`: `person`).                           |
| `--fields`                          | `name:type`, comma-separated. Types (modules/fields): `string`, `text`, `markdown` (text to the API; the web pages edit it with the Markdown editor and show it rendered), `int`, `decimal`, `money` (the web form starts a new amount in the tenant's `money.currency` setting), `bool`, `date` (the web form types it as `2026-01-31` or picks it on a calendar), `datetime`, `enum(a\|b)`, `json`, `user` (a member of the tenant, an assignee: `assigneeId:user?`, optional as a reference is; held as the owner is, `user:<id>`; the web pages pick it by name and show the name; exports write the name, imports take the email or the name), `ref(<feature>)` (the web pages pick it by the target's title, search as one types, and show the title in the list, its filter and the detail: `GET /v1/lists/{subject}/options`; a picker that depends on another field takes `filter={{ productId }}`, lists README). `?` optional, `!unique` unique per tenant, `!unique(<field>)` unique among the records with the same value of another field (`code:string!unique(productId)`: a code per product; records with no product are not compared, so make the product required: the generator makes every reference optional, take its `.optional()` off by hand once both features exist; that field is the record's parent: its title starts with the parent's, files name the record by a path of keys, `ACME/STD`; such a field is no import match key), `!numbered` a string a naming series fills when a create leaves it empty (optional and unique; takes the `sequences` add-on, in place of its `number` column: `reference:string!numbered`). String and text fields are searchable. |
| `--addons`                          | Comma-separated, or `all` (below).                                                                                                     |
| `--soft-delete`                     | A recycle bin (default on; `--soft-delete=false`).                                                                                     |
| `--unit`                            | Records carry their creator's organizational unit; unit leads read their units'.                                                       |
| `--client-access`                   | API clients use their own records.                                                                                                     |
| `--grants none`                     | No seed role gets it: administrators grant it. Default `standard` (editors their own, viewers all).                                    |
| `--idempotency`                     | `required`, `optional` or `off` for the create's `Idempotency-Key` (default: the deployment's).                                        |
| `--approvals`                       | With the approvals add-on: the actions that need approval (default `publish`).                                                         |
| `[path]`, `--flat`, `--skip-import` | Another folder (default `src/features`), files in it directly, no app module line.                                                     |

It writes `<item>.record.ts`, `<items>.tables.ts`, `<item>.schemas.ts`,
`<item>.list.ts`, `<item>.permissions.ts`, `<item>.policy.ts`,
`<items>.service.ts`, `<items>.controller.ts`, `<items>.module.ts`,
`i18n/en.json`, `<items>.e2e-spec.ts` (the routes and one check per add-on;
it passes as generated) and `README.md`, formatted with the repository's
Prettier config, and adds the module to `src/app.module.ts` as `nest g module`
does. With `--web-root` (the root's `pnpm feature:add`) it also writes the
web app's part (`schematics/web-feature/templates.js`): `features/<items>/`
(`api.ts` queries, `<item>-form.tsx`, `use-<item>-delete.tsx`, `nav.ts`, the
test `<items>.test.tsx`), `routes/_app/<items>/` (list, new, detail, edit) and
`locales/en/<items>.json`. The app finds the nav entry and the texts by glob;
nothing else is edited. The list takes `?bulkRun=<id>` (what a bulk run
changed: the link of its notification). The pages wire four add-ons when
chosen: `custom-fields` (the form's inputs of the active custom fields, sent
as `custom`; their values on the detail page), `merge` (the form warns of
likely duplicates of the title), `recents` (the detail page records the
visit) and `sequences` (a create form's numbering picker when there is more
than one series); the test has a case for each. CI proves the pages by
generating a feature, type-checking the app and running their test
(`verify`). Then:

```bash
pnpm --filter api db:generate --name invoices   # the table's migration
pnpm --filter api test:e2e src/features/invoices/invoices.e2e-spec.ts
pnpm client:generate        # the typed client the web pages use
```

### A child table

A feature with a reference to another is that one's child: the lines of an
invoice (`pnpm feature:add invoice-lines --fields "item:string,qty:int,price:money,invoiceId:ref(invoices)?"`).
Take the reference's `.optional()` off once both features exist: a line
always has its invoice.

- **The parent's page lists its children** in the Related tab as a table,
  with every one of the child's own fields (a wide one scrolls sideways),
  newest first, 10 a page with Previous and Next, however many there are.
- **"Open all"** opens the child's own list narrowed to the parent
  (`/invoice-lines?invoiceId=<id>`: a generated list takes each of its
  references this way), to search, sort, filter and export them. A title
  opens the child's own page.
- **Add, change and delete in place:** the child's `record-form.tsx`
  (generated) opens its form in a dialog, the parent filled in, and its
  delete. Each goes through the child's own routes and permissions: Add for
  whoever may create one, a row's buttons for whoever may change or delete
  it. After a save the parent's page is read again, as it may show what its
  children changed.
- **A child saved another way** (a log, an activity: added through the
  parent's own route, never changed or deleted) writes its
  `record-form.tsx` by hand: its own `Form`, `useCanAdd` for who may add
  one, and no `useDelete` (no delete button). What the parent keeps of its
  latest child (a status, the last activity's date) is the parent's: its
  service sets it in the same transaction.
- **A hand-written feature** joins by writing the two files
  (`components/records/record-forms.ts`, `features/watching/record-links.ts`).

A parent with live children can't be deleted (409 `record_referenced`)
until they are. The parent and its children are saved one at a time: what
must hold for an invoice and all its lines together is a check of the
parent's service.

The business logic goes where the generated files say "Business logic": the
service (checks before a write), a `@RecordExtension()` provider of the
feature for what must hold on every write (records README, step 7), the
policy and permissions, and the add-ons' files below.

## Add-ons

Each add-on is one `XModule.forRecord(DECLARATION)` in the feature module's
imports, with what it reads from the bodies, shows and keeps on the row passed
to `recordSchemas()` and `recordTable()`. Its README in `src/modules/<name>`
has its routes.

The add-ons the generator offers are the modules that have a
`src/modules/<name>/<name>.addon.js`: it finds them by glob
(`schematics/feature/addons.js`), so removing a module removes its add-on, and
no list names them. That file says what the generator writes for it: the
imports, the `forRecord()` call, what the generated e2e spec boots, the
pieces on the schemas and the table, the variables it needs, and any file of
its own (`<item>.approvals.ts`, `<item>.computed.ts`, `<item>.choices.ts`,
`templates/<item>.html`) or refusal (merge needs the recycle bin, choices an
enum field). What an add-on adds to a generated feature is tested beside it,
in `<name>.addon.spec.ts`. An unknown `--addons` name lists the ones there
are.

## Change or remove one

Change a field, the recycle bin or the units in `<item>.record.ts`, then run
`pnpm --filter api db:generate`; take or drop an add-on by its line in the module (and
its pieces in the schemas or table). Remove a feature with
`pnpm module:remove features/<name>` (a dry run; `--apply` deletes its folder,
its line in `src/app.module.ts` and its web pages, then writes the migration,
the client and the route tree: [removing-a-module.md](removing-a-module.md)).

## Examples

- `apps/api/test/fixtures/test-items`: the hand-written reference of the nine
  files, with a logic extension (`test-item.logic.ts`) and an add-on of its
  own (`marks`). The add-ons' tests run on it.
- `apps/api/test/fixtures/generated-feature`: a feature generated with every
  add-on on, never edited by hand. `test/fixtures/generated-feature.spec.ts`
  runs the schematic with the options in
  `test/fixtures/generated-feature.options.json` and checks it equals the
  files on disk; its own e2e spec boots it with all its add-ons.
  `pnpm module:remove` regenerates it when it removes an add-on. After a
  change to the schematic, regenerate it from `apps/api` with those options
  (delete the folder first), then its migration
  (`pnpm --filter api db:generate:fixtures`):

  ```bash
  pnpm feature:add generated-items test/fixtures/generated-feature --flat --skip-import --unit --addons all --fields "title:string,body:text?,status:enum(draft|done),amount:money?,dueOn:date?,code:string!unique"
  ```
