import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readEnv } from './env.js';
import { optional, secret } from './env.helpers.js';

const schema = z.object({
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
});

describe('readEnv', () => {
  it('returns the checked values, converted, with defaults', () => {
    expect(
      readEnv(schema, { DATABASE_URL: 'postgres://localhost/app', HOME: '/' }),
    ).toEqual({
      DATABASE_URL: 'postgres://localhost/app',
      DATABASE_POOL_MAX: 10,
    });
  });

  it('names every variable at fault, and no value', () => {
    const read = () =>
      readEnv(schema, { DATABASE_URL: 'secret', DATABASE_POOL_MAX: '0' });
    expect(read).toThrow(/DATABASE_URL: .+\nDATABASE_POOL_MAX: /);
    expect(read).not.toThrow(/secret/);
  });
});

describe('readEnv secrets from files', () => {
  const VALUE = `value-${crypto.randomUUID()}`;
  const secrets = z.object({ API_KEY: secret(optional()), PORT: optional() });
  const dir = mkdtempSync(join(tmpdir(), 'env-'));
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, `${VALUE}\r\n\n`);
  writeFileSync(join(dir, 'empty'), '\n');
  afterAll(() => rmSync(dir, { recursive: true }));

  it('reads X from the file X_FILE names, without its line breaks', () => {
    expect(readEnv(secrets, { API_KEY_FILE: keyFile }).API_KEY).toBe(VALUE);
  });

  it('takes an empty X as unset', () => {
    const env = { API_KEY: '', API_KEY_FILE: keyFile };
    expect(readEnv(secrets, env).API_KEY).toBe(VALUE);
  });

  it('keeps X when there is no X_FILE, and ignores X_FILE of a plain variable', () => {
    expect(readEnv(secrets, { API_KEY: 'k', PORT_FILE: keyFile })).toEqual({
      API_KEY: 'k',
    });
  });

  it('refuses X and X_FILE both set', () => {
    const read = () =>
      readEnv(secrets, { API_KEY: 'k', API_KEY_FILE: keyFile });
    expect(read).toThrow('API_KEY and API_KEY_FILE are both set: keep one');
    expect(read).not.toThrow(new RegExp(VALUE));
  });

  it('names the path of a missing or empty file, with every other problem', () => {
    const env = { API_KEY_FILE: join(dir, 'nope'), DATABASE_URL: VALUE };
    const both = z.object({ ...secrets.shape, DATABASE_URL: z.url() });
    const read = () => readEnv(both, env);
    expect(read).toThrow(
      /API_KEY_FILE: can't read .*nope \(ENOENT\)\nDATABASE_URL:/,
    );
    expect(read).not.toThrow(new RegExp(VALUE));
    expect(() =>
      readEnv(secrets, { API_KEY_FILE: join(dir, 'empty') }),
    ).toThrow(/API_KEY_FILE: .*empty is empty/);
  });
});
