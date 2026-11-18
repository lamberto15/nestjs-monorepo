import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * The modules of src and who imports whom, read from the imports
 * themselves. Two callers: src/module-graph.spec.ts checks the dependency
 * rule (root AGENTS.md, rule 4) on it, and tools/module.mjs (`pnpm
 * module:remove`, `pnpm module:list`) finds what depends on a module before
 * removing it. Plain, erasable TypeScript: the tool loads it with Node's type
 * stripping, so it imports nothing but Node's own modules.
 */
export const LEVELS = ['core', 'iam', 'modules', 'features'];

/** A unit or e2e test: it may boot what it needs, so the rule leaves it out. */
export const isTest = (file: string) => /\.(spec|e2e-spec)\.ts$/.test(file);

/** Every TypeScript file under `dir`, tests included. */
export function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

/** `iam/access` for a file under src/iam/access; undefined for app.module.ts and the like. */
export function moduleOf(src: string, file: string) {
  const [level, name] = relative(src, file).split('/');
  return LEVELS.includes(level!) && name ? `${level}/${name}` : undefined;
}

/**
 * The files one source imports by a relative path, resolved: `from './x.js'`,
 * `import './x.js'` and `import('./x.js')`.
 */
export function importsOf(file: string, text = readFileSync(file, 'utf8')) {
  return [...text.matchAll(/(?:from|import)\s*\(?\s*'(\.\.?\/[^']+)'/g)].map(
    ([, target]) => resolve(dirname(file), target!),
  );
}

/** The level of `core/x`, `iam/x`…: 0 for core, 3 for features. */
export const levelOf = (module: string) =>
  LEVELS.indexOf(module.split('/')[0]!);

/** Module → the modules its code (tests left out) imports. */
export function moduleGraph(src: string) {
  const edges = new Map<string, Set<string>>();
  for (const file of sources(src)) {
    const from = moduleOf(src, file);
    if (!from || isTest(file)) continue;
    for (const target of importsOf(file)) {
      const to = moduleOf(src, target);
      if (to && to !== from) {
        edges.set(from, (edges.get(from) ?? new Set()).add(to));
      }
    }
  }
  return edges;
}
