import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { check } from './template.mjs';

const git = (cwd, ...args) => {
  const run = spawnSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
};

function write(root, file, text) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

describe('template:check', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'template-check-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  write(root, 'template.json', '{ "name": "t", "version": "0.1.0" }\n');
  write(root, 'package.json', '{ "name": "t" }\n');
  write(root, 'apps/api/src/core/http/http.module.ts', 'export {};\n');
  write(root, 'apps/api/src/modules/notes/notes.module.ts', 'export {};\n');
  write(root, 'apps/api/src/app.module.ts', 'export {};\n');
  write(
    root,
    'apps/web/src/nav.ts',
    'export const a = 1;\nexport const notes = 2;\n',
  );
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'template');
  git(root, 'tag', 'v0.1.0');

  it('says when the release tag is missing', () => {
    write(root, 'template.json', '{ "name": "t", "version": "9.9.9" }\n');
    assert.deepEqual(check(root), { tag: 'v9.9.9', missing: true });
    write(root, 'template.json', '{ "name": "t", "version": "0.1.0" }\n');
  });

  it('sorts the differences by how an upgrade treats them', () => {
    // An edit of the template, a dropped module, new files (in a folder of
    // their own or the template's), and what is expected to differ.
    write(
      root,
      'apps/api/src/core/http/http.module.ts',
      'export const x = 1;\n',
    );
    rmSync(path.join(root, 'apps/api/src/modules/notes'), { recursive: true });
    // module:remove drops the module's lines from a shared file.
    write(root, 'apps/web/src/nav.ts', 'export const a = 1;\n');
    write(
      root,
      'apps/api/src/features/orders/orders.module.ts',
      'export {};\n',
    );
    write(root, 'apps/api/src/core/http/extra.ts', 'export {};\n');
    write(root, 'apps/api/src/app.module.ts', 'export const y = 1;\n');
    write(root, 'package.json', '{ "name": "acme" }\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'project');
    // Uncommitted changes count too.
    write(
      root,
      'apps/api/src/modules/billing/billing.module.ts',
      'export {};\n',
    );

    const result = check(root);
    assert.equal(result.tag, 'v0.1.0');
    assert.deepEqual(result.changed, ['apps/api/src/core/http/http.module.ts']);
    assert.deepEqual(result.removed.sort(), [
      'apps/api/src/modules/notes/notes.module.ts',
      'apps/web/src/nav.ts',
    ]);
    assert.deepEqual(result.expected.sort(), [
      'apps/api/src/app.module.ts',
      'package.json',
    ]);
    assert.deepEqual(result.own.sort(), [
      'apps/api/src/core/http/extra.ts',
      'apps/api/src/features/orders/orders.module.ts',
      'apps/api/src/modules/billing/billing.module.ts',
    ]);
  });
});
