import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnv } from '../config/env.js';
import { secretNames } from '../config/secret-files.js';
import { schema } from './encryption.config.js';

describe('the encryption keys are secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'encryption-keys-'));
  const dataFile = join(dir, 'data');
  const indexFile = join(dir, 'index');
  writeFileSync(dataFile, 'data-new, data-old\n');
  writeFileSync(indexFile, 'index-key\n');
  afterAll(() => rmSync(dir, { recursive: true }));

  it('are masked in the logs and read from <NAME>_FILE', () => {
    expect(secretNames(schema)).toEqual([
      'DATA_ENCRYPTION_KEYS',
      'BLIND_INDEX_KEYS',
    ]);
    expect(
      readEnv(schema, {
        DATA_ENCRYPTION_KEYS_FILE: dataFile,
        BLIND_INDEX_KEYS_FILE: indexFile,
      }),
    ).toEqual({
      DATA_ENCRYPTION_KEYS: ['data-new', 'data-old'],
      BLIND_INDEX_KEYS: ['index-key'],
    });
  });

  it('refuses a key list given both inline and as a file', () => {
    expect(() =>
      readEnv(schema, {
        DATA_ENCRYPTION_KEYS: 'inline',
        DATA_ENCRYPTION_KEYS_FILE: dataFile,
      }),
    ).toThrow(
      'DATA_ENCRYPTION_KEYS and DATA_ENCRYPTION_KEYS_FILE are both set: keep one',
    );
  });
});
