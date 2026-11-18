// What an add-on's file (`src/modules/<name>/<name>.addon.js`, read by
// addons.js) builds its part of a generated feature with: the paths of the
// core modules a generated e2e spec may boot, the environment shared by
// several add-ons' specs, and the template helpers. Imports nothing of
// addons.js, which imports the add-ons' files.

export { titleField } from './fields.js';
export { label } from './names.js';

/** Core modules an add-on's generated e2e spec may boot (core is always there). */
export const CORE = {
  QueuesModule: 'core/queues/queues.module.js',
  MetricsModule: 'core/metrics/metrics.module.js',
  SharedHttpClientModule: 'core/http-client/http-client.module.js',
  SharedWorkflowsModule: 'core/workflows/workflows.module.js',
};

export const ENCRYPTION = {
  DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
};
export const WORKERS = {
  APP_ROLE: 'all',
  MAIL_TRANSPORT: 'memory',
  ...ENCRYPTION,
};

export const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** Import lines from [name, module] pairs, grouped by module, in first-seen order. */
export function importLines(entries, typeOnly = new Set()) {
  const byModule = new Map();
  for (const [name, from] of entries) {
    if (!byModule.has(from)) byModule.set(from, []);
    const names = byModule.get(from);
    if (!names.includes(name)) names.push(name);
  }
  return [...byModule]
    .map(([from, names]) => {
      const all = names.every((n) => typeOnly.has(n));
      const list = names.map((n) =>
        !all && typeOnly.has(n) ? 'type ' + n : n,
      );
      return (
        'import ' +
        (all ? 'type ' : '') +
        '{ ' +
        list.join(', ') +
        " } from '" +
        from +
        "';"
      );
    })
    .join('\n');
}

/** A module path under src, from the feature's folder. */
export const src = (c, path) =>
  path.startsWith('node:') ? path : c.src + '/' + path;
