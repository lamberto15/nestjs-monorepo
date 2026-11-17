#!/usr/bin/env node
// Writes apps/api/env.example from the environment schemas of the API's
// modules: every src/**/*.config.ts exports `schema` (a Zod object). With
// --check it writes nothing and fails when the file is stale.
//
// The schemas are loaded from the build output (apps/api/dist, `pnpm build`
// first): the sources are TypeScript with `.js` import specifiers, which
// only the compiler resolves, and the built files are what runs in
// production. A source newer than its built file is an error, not a guess.
//
// Works on any Zod 4 schema, with no import of Zod (it reads `_zod.def`).
// A variable's line comes from `.describe()`, else from the `/** */`
// comment above it in the source; `.meta({ secret })` (the `secret()`
// helper) and `.meta({ example })` (the value shown for a required variable).
import {
  existsSync,
  globSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/api');

/** What a schema says about its variable: type words, a default, whether it must be set. */
export function inspect(schema) {
  const def = schema._zod.def;
  switch (def.type) {
    case 'default':
    case 'prefault': {
      const inner = inspect(def.innerType);
      return { ...inner, optional: true, default: def.defaultValue };
    }
    case 'optional':
    case 'nullable':
      return { ...inspect(def.innerType), optional: true };
    case 'readonly':
    case 'catch':
      return inspect(def.innerType);
    case 'pipe': {
      // preprocess() and transform() are pipes with a transform on one side.
      const [a, b] = [inspect(def.in), inspect(def.out)];
      return {
        optional: a.optional || b.optional,
        default: a.default ?? b.default,
        choices: a.choices ?? b.choices,
      };
    }
    case 'enum':
      return { optional: false, choices: Object.values(def.entries) };
    default:
      return { optional: false };
  }
}

function shapeOf(schema) {
  const def = schema._zod.def;
  if (def.type === 'object') return schema.shape;
  if (def.type === 'pipe') return shapeOf(def.in);
  throw new Error('is not a z.object()');
}

/** The `/** *\/` comment above each `NAME:` in a config's source. */
export function commentsIn(source) {
  const comments = new Map();
  // The body may not run past its own end: an earlier comment (a file's
  // header) is not the variable's.
  const pattern = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*([A-Z][A-Z0-9_]*)\s*:/g;
  for (const [, body, name] of source.matchAll(pattern)) {
    comments.set(
      name,
      body
        .replace(/^\s*\* ?/gm, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  return comments;
}

/** The variables of one `schema`, in declaration order. */
export function variables(schema, source = '') {
  const comments = commentsIn(source);
  return Object.entries(shapeOf(schema)).map(([name, variable]) => {
    const meta = variable.meta?.() ?? {};
    const found = inspect(variable);
    return {
      name,
      description: meta.description ?? comments.get(name) ?? '',
      secret: meta.secret === true,
      required: !found.optional,
      example: meta.example,
      default: found.default,
      choices: found.choices,
    };
  });
}

/** The example file for groups `{ title, variables }`. */
export function render(groups) {
  const lines = [
    '# Generated from the src/**/*.config.ts schemas by tools/env-example.mjs.',
    '# Do not edit: change a schema and run `pnpm env:example`.',
    '# Copy to .env (cp env.example .env). A line starting with # is optional,',
    '# shown with its default.',
  ];
  const seen = new Set();
  for (const { title, variables } of groups) {
    const own = variables.filter(({ name }) => !seen.has(name));
    if (own.length === 0) continue;
    lines.push('', `# --- ${title} ---`);
    for (const variable of own) {
      seen.add(variable.name);
      const notes = [
        variable.description,
        variable.choices && `One of: ${variable.choices.join(', ')}.`,
        variable.secret &&
          `Secret: ${variable.name}_FILE can name a file holding it instead.`,
        variable.required && 'Required.',
      ].filter(Boolean);
      lines.push(...notes.map((note) => `# ${note}`));
      const value = Array.isArray(variable.default)
        ? variable.default.join(',')
        : (variable.default ?? variable.example ?? '');
      lines.push(`${variable.required ? '' : '# '}${variable.name}=${value}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Loads every config's schema from dist; throws one message listing what is wrong. */
export async function collect(dir = apiDir) {
  const configs = globSync('**/*.config.ts', { cwd: join(dir, 'src') }).sort();
  const groups = [];
  const problems = [];
  for (const path of configs) {
    const built = join(dir, 'dist', path.replace(/\.ts$/, '.js'));
    const source = join(dir, 'src', path);
    if (
      !existsSync(built) ||
      statSync(built).mtimeMs < statSync(source).mtimeMs
    ) {
      problems.push(
        `src/${path}: not built or older than its source (run pnpm build)`,
      );
      continue;
    }
    try {
      const { schema } = await import(pathToFileURL(built).href);
      if (!schema) {
        problems.push(`src/${path}: exports no \`schema\``);
        continue;
      }
      groups.push({
        title:
          dirname(path) === '.' ? basename(path, '.config.ts') : dirname(path),
        variables: variables(schema, readFileSync(source, 'utf8')),
      });
    } catch (error) {
      problems.push(`src/${path}: ${error.message}`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return groups;
}

async function main() {
  const check = process.argv.includes('--check');
  const target = join(apiDir, 'env.example');
  const next = render(await collect());
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (check) {
    if (current !== next) {
      console.error('apps/api/env.example is stale: run pnpm env:example');
      process.exit(1);
    }
  } else if (current !== next) {
    writeFileSync(target, next);
    console.log('apps/api/env.example written');
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
