// The web app's route tree (apps/web/src/routeTree.gen.ts), written now: the
// router plugin writes it on the next `pnpm dev` or build, and the
// type-check needs it before either. Two callers: tools/feature-add.mjs
// after it adds pages, tools/module.mjs after it removes them.
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO } from './cli-paths.mjs';

export async function regenerateRouteTree(root = REPO) {
  const web = path.join(root, 'apps/web');
  // Resolved from the web app, which owns it.
  const { Generator, getConfig } = createRequire(
    path.join(web, 'package.json'),
  )('@tanstack/router-generator');
  const config = getConfig({ target: 'react', autoCodeSplitting: true }, web);
  await new Generator({ config, root: web }).run();
  console.log('  ~ apps/web/src/routeTree.gen.ts (regenerated)');
}
