#!/usr/bin/env node
// `pnpm run setup`: writes apps/api/.env from apps/api/env.example and
// generates its secrets. Safe to repeat: an existing file keeps its values
// and only gets what is still unset. The environment is checked at the end
// (check.mjs): every variable the template marks "Required." must be set.
//
//   pnpm run setup                         # writes apps/api/.env (mode 600)
//   pnpm run setup --web-push mailto:ops@example.com   # also turns web push on, with a VAPID key pair
//   pnpm run setup --rotate                # a new key in front of each key list
//   pnpm run setup --check                 # writes nothing: checks the file
//   pnpm run setup --dry-run               # says what it would do
//   pnpm run setup --root <dir>            # a copy of the repository (tests use a temp directory)
//   pnpm run setup --dev-ports 1           # a second project on this machine: its services
//                                          # on ports of their own (.env at the root, for
//                                          # compose.dev.yaml) and apps/api/.env pointing at them
//
// Secrets are never printed. The other variables are the template's own
// optional lines: uncomment and set them by hand (docs: each module's README).
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { check } from './check.mjs';
import { setValue, valueOf } from './envfile.mjs';
import { generateVapidKeys } from './vapid.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** Key lists, `openssl rand -base64 32` each: the first encrypts, all decrypt. */
export const KEY_LISTS = [
  'DATA_ENCRYPTION_KEYS',
  'BLIND_INDEX_KEYS',
  'CURSOR_KEYS',
];

const newKey = () => randomBytes(32).toString('base64');

/**
 * Where the web app runs in development: Vite's default port (apps/web sets
 * none). Links in mails open the web app's pages at WEB_URL, which otherwise
 * falls back to APP_URL, the API, where `pnpm dev` serves no pages.
 */
export const DEV_WEB_URL = 'http://localhost:5173';

/**
 * The file's text after setup: each key list gets a key when it is unset (or
 * a new first one with `rotate`), and web push its subject and key pair.
 * WEB_URL gets the web app's development address when unset (not a secret:
 * `defaults`, shown). Returns { text, generated, defaults, warnings }.
 */
export function plan(
  text,
  { rotate = false, webPush, vapid = generateVapidKeys } = {},
) {
  const generated = [];
  const defaults = [];
  const warnings = [];
  const put = (key, value) => {
    const next = setValue(text, key, value);
    if (next === null) warnings.push(`${key} is not in env.example: skipped.`);
    else {
      text = next;
      generated.push(key);
    }
  };
  for (const key of KEY_LISTS) {
    const current = valueOf(text, key);
    if (current === undefined) put(key, newKey());
    else if (rotate) put(key, `${newKey()},${current}`);
  }
  if (valueOf(text, 'WEB_URL') === undefined) {
    const next = setValue(text, 'WEB_URL', DEV_WEB_URL);
    if (next !== null) {
      text = next;
      defaults.push(`WEB_URL=${DEV_WEB_URL}`);
    }
  }
  if (webPush !== undefined) {
    if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s/]+)/.test(webPush)) {
      throw new Error('--web-push: mailto:ops@example.com or an https URL.');
    }
    if (valueOf(text, 'WEB_PUSH_PRIVATE_KEY') === undefined) {
      const keys = vapid();
      if (keys === null) {
        warnings.push(
          'web-push is not installed (pnpm install): no VAPID keys made.',
        );
      } else {
        put('WEB_PUSH_PUBLIC_KEY', keys.publicKey);
        put('WEB_PUSH_PRIVATE_KEY', keys.privateKey);
      }
    }
    if (valueOf(text, 'WEB_PUSH_SUBJECT') === undefined) {
      put('WEB_PUSH_SUBJECT', webPush);
    }
  }
  return { text, generated, defaults, warnings };
}

/**
 * compose.dev.yaml's host ports, today's values by default. `--dev-ports n`
 * moves each up by n (5433, 6380…), so another project's services can run
 * beside this one's.
 */
export const DEV_PORTS = {
  POSTGRES_PORT: 5432,
  REDIS_PORT: 6379,
  GOTENBERG_PORT: 3100,
  GARAGE_PORT: 3900,
  NESTRIX_PORT: 4318,
};

/**
 * The development services of the n-th project on a machine (0: the
 * defaults): the root `.env` docker compose reads (its project name, so
 * containers and volumes are its own, and the host ports) and the API's
 * URLs of them. `name` is the repository folder's.
 */
export function devServices(slot, name) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 99) {
    throw new Error('--dev-ports: a number from 0 (the defaults) to 99.');
  }
  const ports = Object.fromEntries(
    Object.entries(DEV_PORTS).map(([key, port]) => [key, port + slot]),
  );
  const project =
    `${name}-dev`
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '') || 'app-dev';
  return {
    compose: { COMPOSE_PROJECT_NAME: project, ...ports },
    api: {
      DATABASE_URL: `postgres://app_runtime:app_runtime@127.0.0.1:${ports.POSTGRES_PORT}/app`,
      REDIS_URL: `redis://127.0.0.1:${ports.REDIS_PORT}`,
    },
  };
}

/** `current` (a URL) on `wanted`'s port; `wanted` when there is none. */
function onPort(current, wanted) {
  if (current === undefined) return wanted;
  try {
    const url = new URL(current);
    url.port = new URL(wanted).port;
    return url.toString().replace(/\/$/, '');
  } catch {
    return wanted;
  }
}

/** `text` (an env file, maybe empty) with each of `values` set: its line replaced, else added. */
export function withValues(text, values) {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (at === -1) lines.push(`${key}=${value}`);
    else lines[at] = `${key}=${value}`;
  }
  return `${lines.join('\n')}\n`;
}

/** Runs the command; returns the exit code. `io` is for tests. */
export function run(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string' },
      rotate: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'web-push': { type: 'string' },
      'dev-ports': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    out(
      'pnpm run setup [--dev-ports <n>] [--web-push <mailto:… | https://…>] [--rotate] [--check] [--dry-run] [--root <dir>]',
    );
    return 0;
  }
  const root = path.resolve(values.root ?? REPO);
  const templatePath = path.join(root, 'apps/api/env.example');
  const filePath = path.join(root, 'apps/api/.env');
  if (!existsSync(templatePath)) {
    err(`${templatePath} not found.`);
    return 1;
  }
  const template = readFileSync(templatePath, 'utf8');
  const services =
    values['dev-ports'] === undefined
      ? null
      : devServices(Number(values['dev-ports']), path.basename(root));

  if (!values.check) {
    const existed = existsSync(filePath);
    const before = existed ? readFileSync(filePath, 'utf8') : template;
    const planned = plan(before, {
      rotate: values.rotate,
      webPush: values['web-push'],
      vapid: io.vapid,
    });
    const { generated, defaults, warnings } = planned;
    let { text } = planned;
    if (services) {
      // The URLs of this project's services: its own ports, the rest of
      // a URL already set kept (its role, its database).
      for (const [key, value] of Object.entries(services.api)) {
        const next = setValue(text, key, onPort(valueOf(text, key), value));
        if (next !== null) text = next;
      }
      const composePath = path.join(root, '.env');
      const composeBefore = existsSync(composePath)
        ? readFileSync(composePath, 'utf8')
        : '';
      const composeText = withValues(composeBefore, services.compose);
      const { COMPOSE_PROJECT_NAME, POSTGRES_PORT, REDIS_PORT } =
        services.compose;
      out(
        `Development services: project ${COMPOSE_PROJECT_NAME}, PostgreSQL on ${POSTGRES_PORT}, Redis on ${REDIS_PORT} (${composePath}).`,
      );
      if (!values['dry-run'] && composeText !== composeBefore) {
        writeFileSync(composePath, composeText);
      }
    }
    for (const w of warnings) err(`WARNING: ${w}`);
    out(
      existed
        ? `${filePath} exists: its values are kept.`
        : `Writing ${filePath} from env.example.`,
    );
    out(
      generated.length
        ? `Generated (not shown): ${generated.join(', ')}.`
        : 'No secret to generate.',
    );
    if (defaults.length) out(`Set for development: ${defaults.join(', ')}.`);
    if (values['dry-run']) {
      out('Dry run: nothing written.');
    } else if (text !== before || !existed) {
      if (existed) copyFileSync(filePath, `${filePath}.bak`);
      writeFileSync(filePath, text, { mode: 0o600 });
      chmodSync(filePath, 0o600);
      out(
        `Wrote ${filePath}${existed ? ` (the old one: ${filePath}.bak)` : ''}.`,
      );
    }
    if (values['dry-run']) return 0;
  }
  return check(template, filePath, { out, err });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
