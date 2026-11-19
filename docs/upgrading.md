# Upgrading to a newer release of the template

A project started with `pnpm create nestjs-monorepo` has the template's
history and its `template` remote ([getting-started](getting-started.md),
step 2). A newer release is a tag of that remote (`v0.2.0`), merged like any
branch. `template.json` names the release the project is on; the merge
brings the new one.

**Your copy is yours to maintain.** Upgrading is best-effort: a release
promises no compatibility with what a project changed, and a project may
never merge one. What this page gives is the way to take the template's
later fixes and modules when you want them, and to see beforehand what
will conflict.

## Keep upgrades cheap

An upgrade conflicts only where both sides changed the same file. The
project's own code goes where the template has nothing:

- business records in `apps/api/src/features/<name>` (`pnpm feature:add`,
  [adding-a-feature](adding-a-feature.md)), a capability of your own in a
  new `apps/api/src/modules/<name>`, their pages in new files of the web app;
- what a module offers, instead of an edit of it: its environment variables
  (`<name>.config.ts`), its decorators and `forFeature()`/`forRecord()`, its
  events ([architecture](architecture.md), "How modules extend each other");
- a module you don't want: `pnpm module:remove <name> --apply`
  ([removing-a-module](removing-a-module.md)).

An edit of `core`, `iam` or a shipped module is sometimes the only way. Keep
it small, and say in its commit why. When it is missing an extension point,
an issue on the template's repository brings one in a later release, and the
edit goes away.

## See what you changed

```bash
pnpm template:check
```

It compares the project with the release's tag and sorts the differences:

- **template files you changed**: where an upgrade may conflict;
- **removed**: template files you deleted, or that only lost lines (what
  `module:remove` takes out of shared files): the modules you dropped;
- **expected to differ**: what every project changes or a command writes
  again (`package.json`, the lockfile, `app.module.ts`, the migrations,
  `env.example`, the typed client, the route tree, the names people see);
- **your own files**: files the template does not have.

It only reports; it never fails.

## Merge a release

```bash
pnpm template:check                 # what may conflict
git fetch template --tags
git switch -c upgrade-v0.2.0
git merge v0.2.0                    # the release notes: the repository's Releases
```

Then, for each conflict:

| Conflict                                         | Resolve                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A file of a module you removed ("deleted by us") | `git rm <file>`: it stays removed. A new file of that module, merged in without a conflict, goes too: `pnpm module:remove <name> --apply` again. |
| A shared file `module:remove` trimmed            | The template's changes, without the dropped module's lines.                                                                                      |
| `pnpm-lock.yaml`                                 | Take either side, then `pnpm install`: it is written again.                                                                                      |
| `env.example`, the typed client, the route tree  | Take either side, then `pnpm env:example`, `pnpm client:generate`, `pnpm build`: they are written again.                                         |
| A template file you edited                       | Both edits, by hand.                                                                                                                             |

Migrations don't conflict: each is a folder of its own
(`apps/api/drizzle/<timestamp>_<name>`), and the migrator applies every one
the database has not seen, by name, in whatever order the branches made them.
`pnpm --filter api exec drizzle-kit check` (CI runs it) says whether the
template's and yours touch the same table in ways that don't commute; the
next `pnpm db:generate` builds on both.

Then prove it, and merge the branch:

```bash
pnpm install
pnpm --filter api exec drizzle-kit check
pnpm build && pnpm lint && pnpm test && pnpm test:e2e
git switch main && git merge upgrade-v0.2.0
```

One release at a time keeps each merge small: `v0.2.0`, then `v0.3.0`.

## A copy made by hand

A project copied without the template's history (a download, GitHub's "Use
this template") has nothing to merge against. Once, to connect it:

```bash
git remote add template https://github.com/lamberto15/nestjs-monorepo.git
git fetch template --tags
git merge --allow-unrelated-histories -s ours v0.1.0 -m "chore: connect the template's v0.1.0"
```

`-s ours` keeps every file as it is and records the release as merged, so
the next merge brings only what changed after it. Use the release the copy
was made from, and set `template.json` to it.

## For the template's maintainer: a release

```bash
# template.json: "version": "0.2.0"
git commit -am "chore(release): 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

The tag runs `.github/workflows/release.yml`: it checks the tag matches
`template.json`, publishes `create-nestjs-monorepo` at that version to npm
(trusted publishing, with provenance) and writes the release's notes from the
commits since the last tag. `publish.yml` publishes the image for the same
tag ([ci](ci.md)).
