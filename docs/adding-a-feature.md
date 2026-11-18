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
| `--fields`                          | `name:type`, comma-separated. Types (modules/fields): `string`, `text`, `int`, `decimal`, `money`, `bool`, `date`, `datetime`, `enum(a | b)`, `json`, `ref(<feature>)`. `?`optional,`!unique` unique per tenant. String and text fields are searchable. |
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
than one series); the test has a case for each. CI proves the pages by generating a
feature, type-checking the app and running their test (`verify`). Then:

```bash
./node_modules/.bin/drizzle-kit generate --name invoices   # the table's migration
./node_modules/.bin/vitest run --config ./vitest.config.e2e.ts src/features/invoices/invoices.e2e-spec.ts
pnpm client:generate        # from the root: the typed client the web pages use
```

The business logic goes where the generated files say "Business logic": the
service (checks before a write), a `@RecordExtension()` provider of the
feature for what must hold on every write (records README, step 7), the
policy and permissions, and the add-ons' files below.

## Add-ons

Each add-on is one `XModule.forRecord(DECLARATION)` in the feature module's
imports, with what it reads from the bodies, shows and keeps on the row passed
to `recordSchemas()` and `recordTable()`. Its README in `src/modules/<name>`
has its routes.

| Add-on                                                                                                                                                              | What the generator adds besides the import                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| tags                                                                                                                                                                | `TAGS_RESPONSE`                                                                             |
| custom-fields                                                                                                                                                       | `CUSTOM_FIELDS_BODY`, `CUSTOM_FIELDS_RESPONSE`                                              |
| sequences                                                                                                                                                           | `numberColumns()`, `NUMBER_BODY`, `NUMBER_RESPONSE`                                         |
| computed-fields                                                                                                                                                     | `<item>.computed.ts` (the length of the first string field) and its response                |
| approvals                                                                                                                                                           | `<item>.approvals.ts`: one `@ApprovalEffect()` per action, a no-op to fill                  |
| choices                                                                                                                                                             | `<item>.choices.ts`: a `@ChoiceSource()` offering the first enum field's values (needs one) |
| documents                                                                                                                                                           | `templates/<item>.html`, the PDF's page                                                     |
| data-quality                                                                                                                                                        | `recommended`: the optional text fields                                                     |
| retention                                                                                                                                                           | a purge rule, 730 days by default (off until a tenant turns it on)                          |
| merge                                                                                                                                                               | needs the recycle bin and a required string field                                           |
| comments, attachments, revisions, favorites, recents, templates, acknowledgments, bulk, data-transfer, shares, ai, automations, webhooks, notifications, recurrence | the import only                                                                             |

## Change or remove one

Change a field, the recycle bin or the units in `<item>.record.ts`, then run
`drizzle-kit generate`; take or drop an add-on by its line in the module (and
its pieces in the schemas or table). Remove a feature: delete its folder and
its line in `src/app.module.ts`, then generate the migration.

## Examples

- `apps/api/test/fixtures/test-items`: the hand-written reference of the nine
  files, with a logic extension (`test-item.logic.ts`) and an add-on of its
  own (`marks`). The add-ons' tests run on it.
- `apps/api/test/fixtures/generated-feature`: a feature generated with every
  add-on on, never edited by hand. `test/fixtures/generated-feature.spec.ts`
  runs the schematic with the same options and checks it equals the files on
  disk; its own e2e spec boots it with all its add-ons. After a change to the
  schematic, regenerate it (from `apps/api`, delete the folder first) and its
  migration (`--config test/fixtures/drizzle.config.ts --name generated-feature`):

  ```bash
  pnpm feature:add generated-items test/fixtures/generated-feature --flat --skip-import --unit --addons all --fields "title:string,body:text?,status:enum(draft|done),amount:money?,dueOn:date?,code:string!unique"
  ```
