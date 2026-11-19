#!/usr/bin/env node
// `pnpm create nestjs-monorepo <dir>`: a project from a release of the
// template. A clone of the release's tag with its history, the template's
// remote kept as `template`, so a later release is a `git merge` of its tag
// (docs/upgrading.md). A download without history (degit, "Use this
// template") would leave nothing to merge against. Node's standard library
// and git only: nothing to install before the template is there.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const manifest = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);
/** The template's repository: this package's own (package.json). */
const TEMPLATE = manifest.repository.url.replace(/^git\+/, '');

const USAGE = `Usage: pnpm create nestjs-monorepo <dir> [--version <x.y.z>] [--from <git url>] [--no-install]

  --version     a release of the template (default: the newest)
  --from        the template's repository (default: ${TEMPLATE})
  --no-install  skip pnpm install`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed${result.stderr ? `:\n${result.stderr.trim()}` : ''}`,
    );
  }
  return result.stdout ?? '';
}

const compare = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** The newest release: the highest `vX.Y.Z` tag of the repository (pre-releases left out). */
export function newestVersion(from) {
  const versions = run('git', ['ls-remote', '--tags', '--refs', from, 'v*'])
    .split('\n')
    .map((line) => /refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/.exec(line))
    .filter(Boolean)
    .map((match) => match.slice(1).map(Number));
  if (versions.length === 0)
    throw new Error(`${from} has no release tag (v1.2.3).`);
  return versions.sort(compare).at(-1).join('.');
}

/** A package name from the folder's: lower case, letters, digits and dashes. */
export const projectName = (dir) =>
  path
    .basename(path.resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';

function replaceIn(dir, file, from, to) {
  const target = path.join(dir, file);
  if (!existsSync(target)) return;
  const text = readFileSync(target, 'utf8');
  writeFileSync(target, text.replace(from, to));
}

/**
 * The copy: cloned at `v<version>`, on a `main` branch of its own, the
 * project's name where the template carries its own (the root package, the
 * development services' name, the README's title: docs/getting-started.md,
 * "Renaming"), committed.
 */
export function create(dir, { version, from = TEMPLATE } = {}) {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} exists and is not empty.`);
  }
  const release = version ?? newestVersion(from);
  const name = projectName(dir);
  run('git', [
    'clone',
    '--quiet',
    '--origin',
    'template',
    '--branch',
    `v${release}`,
    from,
    dir,
  ]);
  run('git', ['switch', '--quiet', '-c', 'main'], { cwd: dir });
  replaceIn(dir, 'package.json', /"name": "[^"]*"/, `"name": "${name}"`);
  replaceIn(dir, 'compose.dev.yaml', /^name: .*$/m, `name: ${name}-dev`);
  replaceIn(dir, 'README.md', /^# .*$/m, `# ${name}`);
  run(
    'git',
    [
      'commit',
      '--quiet',
      '--all',
      '-m',
      `chore: start ${name} from nestjs-monorepo v${release}`,
    ],
    {
      cwd: dir,
    },
  );
  return { name, release };
}

if (import.meta.main) {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        version: { type: 'string' },
        from: { type: 'string' },
        'no-install': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const [dir] = positionals;
  try {
    const { name, release } = create(dir, {
      version: values.version,
      from: values.from,
    });
    console.log(`${name}: nestjs-monorepo v${release}, in ${dir}.`);
    if (!values['no-install']) {
      spawnSync('pnpm', ['install'], { cwd: dir, stdio: 'inherit' });
    }
    console.log(`
Next:
  cd ${dir}
  pnpm services:up        # PostgreSQL and Redis
  pnpm run setup          # apps/api/.env, with generated keys
  pnpm dev                # http://localhost:5173

Your own repository: git remote add origin <url> && git push -u origin main
A newer release of the template: docs/upgrading.md (pnpm template:check first).`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
