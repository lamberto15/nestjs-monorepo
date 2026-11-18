import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * The feature schematic (apps/api/schematics) on a virtual tree, for its
 * tests: test/fixtures/generated-feature.spec.ts, and each add-on's
 * src/modules/<name>/<name>.addon.spec.ts.
 */
// The devkit is @nestjs/schematics' dependency, not this app's: resolved
// from there (pnpm keeps it out of apps/api/node_modules).
const devkit = createRequire(
  createRequire(import.meta.url).resolve('@nestjs/schematics'),
);
const { SchematicTestRunner, UnitTestTree } = devkit(
  '@angular-devkit/schematics/testing',
) as {
  SchematicTestRunner: new (
    name: string,
    path: string,
  ) => {
    runSchematic(name: string, options: object, tree: unknown): Promise<Tree>;
  };
  UnitTestTree: new (tree: unknown) => Tree;
};
const { Tree: Trees } = devkit('@angular-devkit/schematics') as {
  Tree: { empty(): unknown };
};

export interface Tree {
  files: string[];
  readContent(path: string): string;
  create(path: string, content: string): void;
}

export const runner = new SchematicTestRunner(
  'feature',
  join(import.meta.dirname, '..', 'schematics/collection.json'),
);
export const empty = () => new UnitTestTree(Trees.empty());
