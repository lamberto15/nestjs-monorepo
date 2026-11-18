# modules/config-bundles

Promote a tenant's configuration between environments (a staging tenant to
production): export it as one checksummed file, preview it against another
tenant, apply it there in one transaction.

- `GET /v1/config-bundles/export`: `{ format, version, exportedAt, checksum,
contents }`; `contents` has one section per module, by stable references
  (a setting's key, a role's name), never this environment's ids. No secrets,
  users, grants, API clients or records. `ConfigBundle.export`.
- `POST /v1/config-bundles/preview` `{ bundle }`: a dry run: `valid`,
  `errors`, `warnings`, `changes` (per section and item: create, update,
  unchanged) and `targetVersion`, a checksum of what the target holds for
  what the bundle touches. `ConfigBundle.apply`.
- `POST /v1/config-bundles/apply` `{ bundle, targetVersion }`: applies section by
  section (by their `order`) through each module's own services (their
  checks, locks and audit entries), in one transaction, plus one
  `config-bundle.applied` entry. 409 `config_changed` when the target moved
  since the preview, 400 `validation_failed` when the bundle is invalid here.
  Additive: what the bundle lacks stays.

A newer format, a damaged checksum, a section this deployment doesn't have or
an item its module refuses stops the whole bundle.

`ConfigBundle.apply` writes every section: give it only to people who hold the
permissions of them all (administrators do).

## Sections

Here: `roles` (custom and seeded roles with their permissions; the built-in
Administrator never) and `settings` (tenant-scope values, a flag's rollout and
rules; a rule's role condition travels as role names; applied after roles).

A module with configuration to carry marks a provider, and imports nothing
else of this module:

```ts
@BundleSection('templates', { order: 20 })
@Injectable()
export class TemplatesBundle implements BundleSectionHandler<Template[]> {
  schema = z.array(templateSchema);
  export() {} // the tenant's items, sorted, by reference
  preview(items, bundle) {} // { changes, errors?, warnings?, touched }
  import(actor, items, { changes, ip }) {} // through the module's own service
}
```

`BundleSections` finds them at start. Two sections with one name stop the boot.

## Removing it

Delete the folder and its line in `app.module.ts`.
