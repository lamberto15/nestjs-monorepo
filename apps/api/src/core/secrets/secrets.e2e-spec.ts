import { randomBytes } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import { DatabaseModule } from '../database/database.module.js';
import type { Database } from '../database/database.js';
import { EncryptionModule } from '../encryption/encryption.module.js';
import { SecretsModule } from './secrets.module.js';
import { Secrets } from './secrets.service.js';
import { appSecrets } from './secrets.tables.js';

const boot = async (keys?: string) => {
  if (keys) process.env.DATA_ENCRYPTION_KEYS = keys;
  try {
    return await bootModules(DatabaseModule, EncryptionModule, SecretsModule);
  } finally {
    delete process.env.DATA_ENCRYPTION_KEYS;
  }
};

describe('secrets kept in the database (e2e)', () => {
  const apps: NestNodeApplication[] = [];
  const started = async (keys?: string) => {
    const app = await boot(keys);
    apps.push(app);
    return app;
  };
  const stored = async (app: NestNodeApplication, name: string) => {
    const [row] = await app
      .get<Database>(getDrizzleToken())
      .select()
      .from(appSecrets)
      .where(eq(appSecrets.name, name));
    return row!.value;
  };

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('makes a secret once: every later call, and every instance, gets the same', async () => {
    const [a, b] = [await started(), await started()];
    let made = 0;
    const generate = () => {
      made += 1;
      return randomBytes(32).toString('base64url');
    };
    const values = await Promise.all([
      a.get(Secrets).loadOrCreate('shared', generate),
      b.get(Secrets).loadOrCreate('shared', generate),
      a.get(Secrets).loadOrCreate('shared', generate),
    ]);
    expect(new Set(values).size).toBe(1);
    expect(await b.get(Secrets).loadOrCreate('shared', generate)).toBe(
      values[0],
    );
    expect(made).toBeGreaterThanOrEqual(1);
    // No data keys: kept as it is.
    expect(await stored(a, 'shared')).toBe(values[0]);
  });

  it('encrypts with the data keys, and moves a plaintext or old-key value to the current key', async () => {
    const plain = await started();
    const value = await plain
      .get(Secrets)
      .loadOrCreate('moved', () => 'the-secret-value');
    expect(await stored(plain, 'moved')).toBe('the-secret-value');

    const oldKey = randomBytes(32).toString('base64');
    const old = await started(oldKey);
    expect(await old.get(Secrets).loadOrCreate('moved', () => 'other')).toBe(
      value,
    );
    const sealed = await stored(old, 'moved');
    expect(sealed).not.toContain('the-secret-value');

    const newKey = randomBytes(32).toString('base64');
    const rotated = await started(`${newKey},${oldKey}`);
    expect(
      await rotated.get(Secrets).loadOrCreate('moved', () => 'other'),
    ).toBe(value);
    const resealed = await stored(rotated, 'moved');
    expect(resealed).not.toBe(sealed);
    expect(resealed).not.toContain('the-secret-value');

    // A new secret under keys is stored sealed from the start.
    const fresh = await rotated
      .get(Secrets)
      .loadOrCreate('fresh', () => 'brand-new');
    expect(fresh).toBe('brand-new');
    expect(await stored(rotated, 'fresh')).not.toContain('brand-new');
  });
});
