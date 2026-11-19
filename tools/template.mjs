#!/usr/bin/env node
// `pnpm template:check`: in a copy of the template, what the project changed
// in the template's own files since the release it is on (docs/upgrading.md).
// The release is template.json's `version`, whose tag (`v<version>`) a copy
// has from its `template` remote; a merge of a newer tag brings a newer
// template.json, so nothing else records it. Git already knows every
// difference: this only sorts them, by how an upgrade treats them. It warns
// and exits 0: what the project changes is its own.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO } from './cli-paths.mjs';

/**
 * Files a project is expected to change, or that commands write again
 * (module:remove, feature:add, db:generate, client:generate): different,
 * and no sign of an edit to the template.
 */
const EXPECTED = [
  /(^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^README\.md$/,
  /^compose\.dev\.yaml$/,
  /^apps\/api\/src\/app\.module\.ts$/,
  /^apps\/api\/drizzle\//,
  /^apps\/api\/env\.example$/,
  /^apps\/api\/test\/fixtures\/generated-feature/,
  /^apps\/web\/src\/routeTree\.gen\.ts$/,
  /^packages\/api-client\/(src\/|openapi\.json$)/,
  // The names people see (docs/getting-started.md, "Renaming").
  /^apps\/web\/src\/locales\/en\/common\.json$/,
  /^apps\/web\/index\.html$/,
  /^apps\/web\/vite\.config\.ts$/,
  /^apps\/api\/src\/core\/http\/openapi\.ts$/,
];

const git = (root, ...args) => {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (run.status !== 0)
    throw new Error(run.stderr.trim() || `git ${args[0]} failed`);
  return run.stdout;
};
const lines = (text) => text.split('\n').filter(Boolean);

/**
 * The project's differences from the release's tag, sorted:
 * `changed` (template files with lines added or edited: an upgrade may
 * conflict there), `removed` (template files deleted, or that only lost
 * lines, as module:remove leaves them: a conflict in one keeps the
 * removal), `expected` and `own` (files the template
 * does not have: an upgrade never conflicts on them, unless the template
 * adds one at the same path).
 */
export function check(root) {
  const { version } = JSON.parse(
    readFileSync(path.join(root, 'template.json'), 'utf8'),
  );
  const tag = `v${version}`;
  const known = spawnSync(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`],
    {
      cwd: root,
    },
  );
  if (known.status !== 0) {
    return { tag, missing: true };
  }
  const result = { tag, changed: [], removed: [], expected: [], own: [] };
  // Lines added per file (`-` for a binary one): none is a removal only.
  const added = new Map(
    lines(git(root, 'diff', '--numstat', '--no-renames', tag)).map((line) => {
      const [plus, , file] = line.split('\t');
      return [file, plus];
    }),
  );
  const entries = [
    // Tracked files against the tag, uncommitted changes included.
    ...lines(git(root, 'diff', '--name-status', '--no-renames', tag)).map(
      (line) => {
        const [status, file] = line.split('\t');
        return { status: status[0], file };
      },
    ),
    ...lines(git(root, 'ls-files', '--others', '--exclude-standard')).map(
      (file) => ({
        status: 'A',
        file,
      }),
    ),
  ];
  for (const { status, file } of entries) {
    if (EXPECTED.some((pattern) => pattern.test(file)))
      result.expected.push(file);
    else if (status === 'D' || (status === 'M' && added.get(file) === '0'))
      result.removed.push(file);
    else if (status === 'A') result.own.push(file);
    else result.changed.push(file);
  }
  return result;
}

function report(result) {
  if (result.missing) {
    console.log(
      `The tag ${result.tag} (template.json) is not here: git fetch template --tags (docs/upgrading.md).`,
    );
    return;
  }
  console.log(`Compared with the template's ${result.tag} (template.json):\n`);
  if (result.changed.length > 0) {
    console.log(
      `Template files you changed: ${result.changed.length}. An upgrade may conflict in them; an extension point in the template would avoid the edit (docs/upgrading.md).`,
    );
    for (const file of result.changed.sort()) console.log(`  ${file}`);
  } else {
    console.log('Template files you changed: none.');
  }
  console.log(
    `\nRemoved: ${result.removed.length} (files deleted, or that only lost lines: a module you dropped; on an upgrade, a conflict in one keeps the removal, docs/upgrading.md).`,
  );
  console.log(
    `Expected to differ (yours, or written by a command): ${result.expected.length}.`,
  );
  console.log(
    `Your own files (the template has none of them): ${result.own.length}.`,
  );
}

if (import.meta.main) {
  const { positionals } = parseArgs({ allowPositionals: true });
  if (positionals[0] !== 'check') {
    console.error('Usage: node tools/template.mjs check');
    process.exit(2);
  }
  const remotes = lines(git(REPO, 'remote'));
  if (!remotes.includes('template')) {
    console.log(
      'No `template` remote: this is the template itself, or a copy made without create-nestjs-monorepo (docs/upgrading.md, "A copy made by hand").',
    );
    process.exit(0);
  }
  report(check(REPO));
}
