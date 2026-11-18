// The add-ons a generated feature may take (`--addons`): found, not listed.
// Each is a module of src/modules with a `<name>.addon.js` beside its code:
// what it adds to a feature (the import and its `forRecord()` in the
// feature module, the body and response pieces of recordSchemas(), a column
// of recordTable(), files of the feature's own, what the generated e2e spec
// boots and sets, and its check there; modules/records/README.md, "Writing
// an add-on"). Deleting a module (`pnpm module:remove`) takes its add-on
// out of the generator with nothing here to edit.

import { globSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';

/** The API's src, beside this schematic (apps/api/schematics/feature). */
const SRC = join(import.meta.dirname, '..', '..', 'src');

/**
 * Every add-on: name (its module's folder) → what it adds, in `order`.
 * Loaded with require(): the devkit require()s this schematic, so nothing
 * in it may await at the top.
 */
function discover() {
  const require = createRequire(import.meta.url);
  const found = globSync('modules/*/*.addon.js', { cwd: SRC }).map((file) => {
    const name = basename(dirname(file));
    if (basename(file) !== `${name}.addon.js`) {
      throw new Error(
        `src/${file}: an add-on's file is named <module>.addon.js.`,
      );
    }
    return [name, require(join(SRC, file)).default];
  });
  return Object.fromEntries(
    found.sort(([a, x], [b, y]) => x.order - y.order || a.localeCompare(b)),
  );
}

export const ADDONS = discover();

/**
 * The modules the generated e2e spec boots for `addons`, [name, path under
 * src], in app.module.ts's order: the app's dependency order (the one used
 * comes first), so no list of its own.
 */
export function bootOf(addons) {
  const wanted = new Map();
  for (const name of addons) {
    for (const [module, path] of Object.entries(ADDONS[name].boot ?? {})) {
      wanted.set(module, path);
    }
  }
  const app = readFileSync(join(SRC, 'app.module.ts'), 'utf8');
  const at = (module) => {
    const found = app.search(new RegExp(`^\\s+${module},$`, 'm'));
    return found < 0 ? Infinity : found;
  };
  return [...wanted].sort(([a], [b]) => at(a) - at(b));
}

/** `--addons tags,comments` (or `all`): the add-ons, checked, in their order. */
export function parseAddons(list) {
  const raw = Array.isArray(list) ? list : String(list ?? '').split(',');
  const wanted = raw.map((name) => String(name).trim()).filter(Boolean);
  if (wanted.includes('all')) return Object.keys(ADDONS);
  for (const name of wanted) {
    if (!ADDONS[name]) {
      throw new Error(
        `--addons: "${name}" is not an add-on; any of ${Object.keys(ADDONS).join(', ')}, or all.`,
      );
    }
  }
  return Object.keys(ADDONS).filter((name) => wanted.includes(name));
}
