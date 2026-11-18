import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compare, parseEnv, setValue, valueOf } from './envfile.mjs';
import { KEY_LISTS, plan, run } from './setup.mjs';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const real = readFileSync(path.join(REPO, 'apps/api/env.example'), 'utf8');

const TEMPLATE = [
  '# The database.',
  '# Required.',
  'DATABASE_URL=postgres://u:p@host/db',
  '# Data keys.',
  '# DATA_ENCRYPTION_KEYS=',
  '# BLIND_INDEX_KEYS=',
  '',
  '# Cursor keys.',
  '# CURSOR_KEYS=',
  '# WEB_PUSH_SUBJECT=',
  '# WEB_PUSH_PUBLIC_KEY=',
  '# WEB_PUSH_PRIVATE_KEY=',
  '',
].join('\n');

/** A copy of the repository's shape in a temp directory: never the real one. */
function sandbox(template = TEMPLATE) {
  const root = mkdtempSync(path.join(tmpdir(), 'setup-test-'));
  mkdirSync(path.join(root, 'apps/api'), { recursive: true });
  writeFileSync(path.join(root, 'apps/api/env.example'), template);
  return root;
}
const quiet = () => {
  const lines = [];
  return { lines, out: (l) => lines.push(l), err: (l) => lines.push(l) };
};
const keys = { publicKey: 'PUB', privateKey: 'PRIV' };

test('the template names what setup generates, and marks the database as required', () => {
  const named = new Set(parseEnv(real).map((e) => e.key));
  for (const key of KEY_LISTS) assert.ok(named.has(key), key);
  assert.ok(parseEnv(real).some((e) => e.key === 'DATABASE_URL' && e.required));
});

test('parses active, commented and required variables', () => {
  const found = parseEnv(TEMPLATE);
  assert.equal(found.find((e) => e.key === 'DATABASE_URL').required, true);
  assert.equal(
    found.find((e) => e.key === 'DATA_ENCRYPTION_KEYS').active,
    false,
  );
  assert.equal(
    found.find((e) => e.key === 'DATA_ENCRYPTION_KEYS').required,
    false,
  );
  assert.equal(valueOf(TEMPLATE, 'DATABASE_URL'), 'postgres://u:p@host/db');
  assert.equal(valueOf(TEMPLATE, 'CURSOR_KEYS'), undefined);
});

test('setValue activates the commented line, or replaces the active one', () => {
  const set = setValue(TEMPLATE, 'CURSOR_KEYS', 'abc=');
  assert.equal(valueOf(set, 'CURSOR_KEYS'), 'abc=');
  assert.ok(!set.includes('# CURSOR_KEYS'));
  assert.equal(valueOf(setValue(set, 'CURSOR_KEYS', 'x'), 'CURSOR_KEYS'), 'x');
  assert.equal(setValue(TEMPLATE, 'NOT_THERE', 'x'), null);
});

test('compare: unset required, unknown and repeated variables', () => {
  const file = 'DATABASE_URL=\nTYPO=1\nCURSOR_KEYS=a\nCURSOR_KEYS=b\n';
  assert.deepEqual(compare(TEMPLATE, file), {
    empty: ['DATABASE_URL'],
    unknown: ['TYPO'],
    repeated: ['CURSOR_KEYS'],
  });
});

test('plan generates each key list once and keeps the existing ones', () => {
  const first = plan(TEMPLATE);
  assert.deepEqual(first.generated, KEY_LISTS);
  for (const key of KEY_LISTS) {
    assert.equal(Buffer.from(valueOf(first.text, key), 'base64').length, 32);
  }
  const again = plan(first.text);
  assert.equal(again.text, first.text);
  assert.deepEqual(again.generated, []);
});

test('plan --rotate puts a new key in front of the old one', () => {
  const first = plan(TEMPLATE).text;
  const rotated = plan(first, { rotate: true }).text;
  const [fresh, old] = valueOf(rotated, 'DATA_ENCRYPTION_KEYS').split(',');
  assert.equal(old, valueOf(first, 'DATA_ENCRYPTION_KEYS'));
  assert.notEqual(fresh, old);
});

test('plan --web-push sets the subject and a VAPID pair, once', () => {
  const { text } = plan(TEMPLATE, {
    webPush: 'mailto:ops@example.com',
    vapid: () => keys,
  });
  assert.equal(valueOf(text, 'WEB_PUSH_SUBJECT'), 'mailto:ops@example.com');
  assert.equal(valueOf(text, 'WEB_PUSH_PUBLIC_KEY'), 'PUB');
  assert.equal(valueOf(text, 'WEB_PUSH_PRIVATE_KEY'), 'PRIV');
  const again = plan(text, {
    webPush: 'mailto:other@example.com',
    vapid: () => ({ publicKey: 'X', privateKey: 'Y' }),
  });
  assert.equal(valueOf(again.text, 'WEB_PUSH_PRIVATE_KEY'), 'PRIV');
  assert.throws(() => plan(TEMPLATE, { webPush: 'nope' }), /--web-push/);
  assert.match(
    plan(TEMPLATE, { webPush: 'mailto:a@b.co', vapid: () => null }).warnings[0],
    /web-push is not installed/,
  );
});

test('a variable the template does not name is a warning, not a crash', () => {
  const { warnings } = plan('# Required.\nDATABASE_URL=x\n');
  assert.equal(warnings.length, KEY_LISTS.length);
});

test('the command writes .env with mode 600, then keeps it', () => {
  const root = sandbox();
  try {
    const io = quiet();
    assert.equal(run(['--root', root], io), 0);
    const file = path.join(root, 'apps/api/.env');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const written = readFileSync(file, 'utf8');
    assert.ok(valueOf(written, 'DATA_ENCRYPTION_KEYS'));
    assert.ok(
      !io.lines.join('\n').includes(valueOf(written, 'DATA_ENCRYPTION_KEYS')),
    );
    assert.equal(run(['--root', root], quiet()), 0);
    assert.equal(readFileSync(file, 'utf8'), written);
    assert.ok(!existsSync(file + '.bak'));
    assert.equal(run(['--root', root, '--rotate'], quiet()), 0);
    assert.ok(existsSync(file + '.bak'));
    assert.equal(readFileSync(file + '.bak', 'utf8'), written);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--dry-run writes nothing; --check fails on an unset required variable', () => {
  const root = sandbox();
  try {
    assert.equal(run(['--root', root, '--dry-run'], quiet()), 0);
    assert.ok(!existsSync(path.join(root, 'apps/api/.env')));
    assert.equal(run(['--root', root, '--check'], quiet()), 1);
    writeFileSync(path.join(root, 'apps/api/.env'), 'DATABASE_URL=\n');
    const io = quiet();
    assert.equal(run(['--root', root, '--check'], io), 1);
    assert.ok(io.lines.includes('REQUIRED and unset: DATABASE_URL'));
    writeFileSync(path.join(root, 'apps/api/.env'), 'DATABASE_URL=x\n');
    assert.equal(run(['--root', root, '--check'], quiet()), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real template: setup in a sandbox ends with a passing check', () => {
  const root = sandbox(real);
  try {
    const io = quiet();
    assert.equal(run(['--root', root], io), 0, io.lines.join('\n'));
    assert.ok(!io.lines.some((l) => l.startsWith('WARNING')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
