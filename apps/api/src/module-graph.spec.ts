import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * The dependency rule (root AGENTS.md, rule 4), checked on the imports
 * themselves: `core` ← `iam` ← `modules` ← `features`, and among the
 * modules of one level no cycle. `core` is one unit, always there
 * together (its database and tenancy parts know each other), so cycles are
 * looked for above it. Tests are left out: a test may boot what it needs.
 */
const SRC = import.meta.dirname;
const LEVELS = ['core', 'iam', 'modules', 'features'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !/\.(spec|e2e-spec)\.ts$/.test(name)
      ? [path]
      : [];
  });
}

/** `iam/access` for a file under src/iam/access; undefined for app.module.ts and the like. */
function moduleOf(file: string) {
  const [level, name] = relative(SRC, file).split('/');
  return LEVELS.includes(level!) && name ? `${level}/${name}` : undefined;
}

const edges = new Map<string, Set<string>>();
for (const file of sources(SRC)) {
  const from = moduleOf(file);
  if (!from) continue;
  const text = readFileSync(file, 'utf8');
  for (const [, target] of text.matchAll(/from '(\.\.?\/[^']+)'/g)) {
    const to = moduleOf(resolve(dirname(file), target!));
    if (to && to !== from) {
      edges.set(from, (edges.get(from) ?? new Set()).add(to));
    }
  }
}

const level = (module: string) => LEVELS.indexOf(module.split('/')[0]!);

describe('the module graph', () => {
  it('never imports a higher level', () => {
    const upward = [...edges].flatMap(([from, targets]) =>
      [...targets]
        .filter((to) => level(to) > level(from))
        .map((to) => `${from} -> ${to}`),
    );
    expect(upward).toEqual([]);
  });

  it('has no cycle', () => {
    const cycles: string[] = [];
    const done = new Set<string>();
    const walk = (module: string, path: string[]) => {
      const at = path.indexOf(module);
      if (at >= 0) {
        cycles.push([...path.slice(at), module].join(' -> '));
        return;
      }
      if (done.has(module)) return;
      for (const next of edges.get(module) ?? []) {
        if (level(next) > 0) walk(next, [...path, module]);
      }
      done.add(module);
    };
    for (const module of edges.keys()) walk(module, []);
    expect(cycles).toEqual([]);
  });
});
