#!/usr/bin/env node
// `pnpm feature:add <name> [options]`: the feature schematic
// (apps/api/schematics) from the repository's root, so one run writes the
// API's files and the web app's pages; then the router's route tree, which
// the web pages' types need. Options are the schematic's
// (apps/api/schematics/feature/schema.json; docs/adding-a-feature.md).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const web = path.join(root, 'apps/web');
const run = spawnSync(
  path.join(root, 'apps/api/node_modules/.bin/schematics'),
  [
    './apps/api/schematics/collection.json:feature',
    '--source-root=apps/api/src',
    '--web-root=apps/web/src',
    '--dry-run=false',
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: 'inherit' },
);
if (run.status !== 0) process.exit(run.status ?? 1);

// The router plugin writes it on the next `pnpm dev` or build; now, so the
// type-check passes before either. Resolved from the web app, which owns it.
const { Generator, getConfig } = createRequire(path.join(web, 'package.json'))(
  '@tanstack/router-generator',
);
const config = getConfig({ target: 'react', autoCodeSplitting: true }, web);
await new Generator({ config, root: web }).run();
console.log('  ~ apps/web/src/routeTree.gen.ts (regenerated)');
