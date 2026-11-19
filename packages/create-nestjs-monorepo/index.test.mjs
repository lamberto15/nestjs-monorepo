import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { create, newestVersion, projectName } from './index.mjs';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
};
const env = {
  ...process.env,
  ...IDENTITY,
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (cwd, ...args) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};

describe('create-nestjs-monorepo', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'create-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  // A template with three releases, one a pre-release, and work after the last.
  const template = path.join(root, 'template');
  git(root, 'init', '-q', '-b', 'main', template);
  const put = (file, text) => writeFileSync(path.join(template, file), text);
  put(
    'package.json',
    '{\n  "name": "nestjs-monorepo",\n  "private": true\n}\n',
  );
  put('compose.dev.yaml', 'name: nestjs-monorepo-dev\nservices: {}\n');
  put('README.md', '# nestjs-monorepo\n\nA template.\n');
  for (const tag of ['v0.1.0', 'v0.10.0', 'v0.11.0-rc.1']) {
    put('template.json', `{ "version": "${tag.slice(1)}" }\n`);
    git(template, 'add', '.');
    git(template, 'commit', '-q', '-m', tag);
    git(template, 'tag', tag);
  }
  put('unreleased.txt', 'not in a release\n');
  git(template, 'add', '.');
  git(template, 'commit', '-q', '-m', 'unreleased');

  it('takes the newest release, numerically, without pre-releases', () => {
    assert.equal(newestVersion(template), '0.10.0');
  });

  it('names the project after its folder', () => {
    assert.equal(projectName('/work/My App'), 'my-app');
    assert.equal(projectName('acme_api'), 'acme-api');
  });

  it('clones the release with its history, renamed and committed', () => {
    // create() commits with the user's git identity: the test's, here.
    Object.assign(process.env, env);
    const dir = path.join(root, 'acme');
    assert.deepEqual(create(dir, { from: template }), {
      name: 'acme',
      release: '0.10.0',
    });
    const read = (file) => readFileSync(path.join(dir, file), 'utf8');
    assert.match(read('package.json'), /"name": "acme"/);
    assert.match(read('compose.dev.yaml'), /^name: acme-dev$/m);
    assert.match(read('README.md'), /^# acme$/m);
    assert.match(read('template.json'), /"0\.10\.0"/);
    assert.equal(git(dir, 'branch', '--show-current'), 'main');
    assert.equal(git(dir, 'remote'), 'template');
    // The tag's history is there to merge against; one commit of its own on top.
    assert.equal(git(dir, 'rev-list', '--count', 'v0.10.0..HEAD'), '1');
    assert.equal(git(dir, 'status', '--porcelain'), '');
  });

  it('refuses a folder that is not empty', () => {
    assert.throws(
      () => create(path.join(root, 'acme'), { from: template }),
      /not empty/,
    );
  });
});
