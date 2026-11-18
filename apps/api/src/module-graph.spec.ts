import { levelOf, moduleGraph } from '../test/module-graph.js';

/**
 * The dependency rule (root AGENTS.md, rule 4), checked on the imports
 * themselves (test/module-graph.ts): `core` ← `iam` ← `modules` ←
 * `features`, and among the modules of one level no cycle. `core` is one
 * unit, always there together (its database and tenancy parts know each
 * other), so cycles are looked for above it. Tests are left out: a test may
 * boot what it needs.
 */
const edges = moduleGraph(import.meta.dirname);

describe('the module graph', () => {
  it('never imports a higher level', () => {
    const upward = [...edges].flatMap(([from, targets]) =>
      [...targets]
        .filter((to) => levelOf(to) > levelOf(from))
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
        if (levelOf(next) > 0) walk(next, [...path, module]);
      }
      done.add(module);
    };
    for (const module of edges.keys()) walk(module, []);
    expect(cycles).toEqual([]);
  });
});
