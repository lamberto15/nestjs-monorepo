// Generates src/schema.ts (openapi-typescript) and src/realtime-events.ts (the
// `x-realtime-events` manifest) from openapi.json.
//
//   node scripts/generate.mjs                   openapi.json -> src/schema.ts
//   node scripts/generate.mjs --from <source>   first replaces openapi.json with
//                                               the document at <source> (a file,
//                                               or the URL of a running API's
//                                               /api-json), then generates
//   node scripts/generate.mjs --check [--from <source>]
//                                               fails when src/schema.ts and
//                                               src/realtime-events.ts differ from
//                                               what openapi.json generates; with
//                                               --from, also when openapi.json
//                                               differs from the document there
//
// One change on the way: `Idempotency-Key` is optional in the types, because
// createApiClient() sends a fresh key on every POST that doesn't set one.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specFile = join(packageDir, 'openapi.json');
const schemaFile = join(packageDir, 'src/schema.ts');
const eventsFile = join(packageDir, 'src/realtime-events.ts');

const HEADER = `/**
 * Generated from openapi.json by \`pnpm client:generate\`: do not edit.
 * \`pnpm client:check\` fails when it is stale.
 */

`;

async function generate(specText) {
  const spec = JSON.parse(specText);
  for (const operations of Object.values(spec.paths ?? {})) {
    for (const operation of Object.values(operations)) {
      for (const parameter of operation?.parameters ?? []) {
        if (
          parameter.in === 'header' &&
          parameter.name.toLowerCase() === 'idempotency-key'
        ) {
          parameter.required = false;
        }
      }
    }
  }
  return HEADER + astToString(await openapiTS(spec));
}

// The realtime manifest (`x-realtime-events`: event name -> description and a
// $ref to the payload's component) as a map of names to payload types.
function generateEvents(specText) {
  const manifest = JSON.parse(specText)['x-realtime-events'] ?? {};
  const entries = Object.entries(manifest).map(([name, event]) => {
    const id = event.payload.$ref.replace('#/components/schemas/', '');
    return `  /** ${event.description.replaceAll('*/', '*\\/')} */\n  ${JSON.stringify(name).replaceAll('"', "'")}: components['schemas']['${id}'];`;
  });
  return `${HEADER}import type { components } from './schema.js';

/** Every event the API pushes on \`/realtime\`, with its payload (the OpenAPI document's \`x-realtime-events\`). */
export interface RealtimeEventPayloads {
${entries.join('\n')}
}
`;
}

/** The document at `--from`, as openapi.json stores it (two-space JSON). */
async function fetchSource(source) {
  const text = /^https?:\/\//.test(source)
    ? await (await fetch(source)).text()
    : readFileSync(resolve(source), 'utf8');
  return JSON.stringify(JSON.parse(text), null, 2) + '\n';
}

const fromIndex = process.argv.indexOf('--from');
const source = fromIndex > 0 ? process.argv[fromIndex + 1] : undefined;
if (fromIndex > 0 && !source) {
  console.error('--from needs a file or a URL.');
  process.exit(2);
}

if (process.argv.includes('--check')) {
  const stale = [];
  if (source && (await fetchSource(source)) !== readFileSync(specFile, 'utf8')) {
    stale.push('openapi.json');
  }
  const spec = readFileSync(specFile, 'utf8');
  if ((await generate(spec)) !== readFileSync(schemaFile, 'utf8')) {
    stale.push('src/schema.ts');
  }
  if (generateEvents(spec) !== readFileSync(eventsFile, 'utf8')) {
    stale.push('src/realtime-events.ts');
  }
  if (stale.length > 0) {
    console.error(
      `packages/api-client: ${stale.join(' and ')} ${stale.length > 1 ? 'are' : 'is'} stale (the API changed). Run pnpm client:generate and commit the result.`,
    );
    process.exit(1);
  }
  console.log(
    'packages/api-client: openapi.json, src/schema.ts and src/realtime-events.ts are up to date.',
  );
} else {
  if (source) {
    writeFileSync(specFile, await fetchSource(source));
  }
  const specText = readFileSync(specFile, 'utf8');
  writeFileSync(schemaFile, await generate(specText));
  writeFileSync(eventsFile, generateEvents(specText));
  console.log(`Generated ${schemaFile} and ${eventsFile}`);
}
