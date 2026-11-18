# Features

The app's business features: one folder each, a record of
[modules/records](../modules/records/README.md) with its routes,
permissions, table, tests and add-ons, and one line in `app.module.ts`.
None ships with the template.

Add one with the `feature` schematic, from `apps/api`:

```bash
./node_modules/.bin/nest g -c ./schematics/collection.json feature invoices
```

[docs/adding-a-feature.md](../../../../docs/adding-a-feature.md) has its options and what to do next.
