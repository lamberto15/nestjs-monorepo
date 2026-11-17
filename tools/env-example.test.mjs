import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { commentsIn, render, variables } from './env-example.mjs';

// Zod is the API's dependency, not the root's.
const api = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { z } = await import(pathToFileURL(api.resolve('zod')).href);

const unsetIfEmpty = (v) => (v === '' ? undefined : v);

describe('env-example', () => {
  it("reads plain Zod and the helpers' shapes", () => {
    const schema = z.object({
      DATABASE_URL: z.url().meta({
        example: 'postgres://app@localhost/app',
        description: 'PostgreSQL.',
      }),
      POOL: z.coerce.number().default(10),
      MODE: z.preprocess(unsetIfEmpty, z.enum(['a', 'b']).default('b')),
      FLAG: z
        .preprocess(unsetIfEmpty, z.enum(['on', 'off']).default('on'))
        .transform((v) => v === 'on'),
      ORIGINS: z
        .preprocess(unsetIfEmpty, z.string().optional())
        .transform((v) => (v ?? '').split(',')),
      KEY: z
        .preprocess(unsetIfEmpty, z.string().optional())
        .meta({ secret: true }),
      TOKEN: z.string().meta({ secret: true }),
    });
    const found = Object.fromEntries(variables(schema).map((v) => [v.name, v]));
    assert.equal(found.DATABASE_URL.required, true);
    assert.equal(found.POOL.default, 10);
    assert.equal(found.POOL.required, false);
    assert.deepEqual(found.MODE.choices, ['a', 'b']);
    assert.equal(found.MODE.default, 'b');
    assert.equal(found.FLAG.default, 'on');
    assert.equal(found.ORIGINS.required, false);
    assert.equal(found.KEY.secret, true);
    assert.equal(found.KEY.required, false);
    assert.equal(found.TOKEN.required, true);
  });

  it('takes a description from the comment above the variable', () => {
    const source =
      '{\n  /** Connections the\n   * process may hold. */\n  POOL: 1,\n  OTHER: 2,\n}';
    assert.equal(
      commentsIn(source).get('POOL'),
      'Connections the process may hold.',
    );
    assert.equal(commentsIn(source).has('OTHER'), false);
  });

  it("does not take an earlier comment for the variable's", () => {
    const source =
      '/** A header. */\nconst a = 1;\n{\n  /** The pool. */\n  POOL: 1,\n}';
    assert.equal(commentsIn(source).get('POOL'), 'The pool.');
  });

  it('renders required, defaulted, secret and repeated variables', () => {
    const schema = z.object({
      URL: z.url().meta({ example: 'http://x.io', description: 'Where.' }),
      POOL: z.coerce.number().default(10),
      KEY: z.string().optional().meta({ secret: true }),
    });
    const text = render([
      { title: 'core/a', variables: variables(schema) },
      { title: 'core/b', variables: variables(z.object({ POOL: z.string() })) },
    ]);
    assert.match(
      text,
      /# --- core\/a ---\n# Where\.\n# Required\.\nURL=http:\/\/x\.io\n# POOL=10\n/,
    );
    assert.match(
      text,
      /# Secret: KEY_FILE can name a file holding it instead\.\n# KEY=\n/,
    );
    assert.doesNotMatch(text, /core\/b/);
    assert.equal(text.match(/POOL=/g).length, 1);
  });
});
