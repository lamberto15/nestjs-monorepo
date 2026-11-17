import { randomBytes } from 'node:crypto';
import { Injectable, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { DatabaseModule } from '../database/database.module.js';
import type { Database } from '../database/database.js';
import { normalizers } from './data-cipher.js';
import {
  blindIndexText,
  EncryptedColumns,
  encrypted,
  encryptedText,
} from './encrypted-columns.js';
import { EncryptionModule } from './encryption.module.js';
import { EncryptionService } from './encryption.service.js';
import { ReencryptionService } from './reencryption.service.js';

const people = pgTable('e2e_encryption_people', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  nationalId: encryptedText('national_id'),
  nationalIdIndex: blindIndexText('national_id_index'),
});
encrypted(people.nationalId, {
  blindIndex: people.nationalIdIndex,
  normalize: normalizers.exact,
});

// A module of its own, as a real one would be: it lists its columns.
@EncryptedColumns([people.nationalId])
@Injectable()
class PeopleService {
  constructor(@InjectDrizzle() readonly db: Database) {}
}

@Module({ providers: [PeopleService], exports: [PeopleService] })
class PeopleModule {}

const TENANT = '0190f5d6-6d5a-7000-8000-000000000001';
const key = () => randomBytes(32).toString('base64');

async function boot(dataKeys: string[], indexKeys: string[]) {
  // The config reads the environment when the module is built.
  process.env.DATA_ENCRYPTION_KEYS = dataKeys.join(',');
  process.env.BLIND_INDEX_KEYS = indexKeys.join(',');
  const moduleRef = await Test.createTestingModule({
    imports: [DatabaseModule, EncryptionModule, PeopleModule],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe('encryption', () => {
  const [oldData, oldIndex] = [key(), key()];
  let db: Database;

  let admin: TestingModule;

  // Its own pool, open for the whole file: each boot() closes its own.
  beforeAll(async () => {
    admin = await Test.createTestingModule({
      imports: [DatabaseModule, PeopleModule],
    }).compile();
    await admin.init();
    db = admin.get(PeopleService).db;
    // Test-only DDL: the table exists for this file alone.
    // As the owner: the app's role may not create tables.
    const owner = drizzle(process.env.DATABASE_OWNER_URL!);
    await owner.execute(sql`create table ${people} (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null,
      national_id text,
      national_id_index text
    )`);
    await owner.$client.end();
  });

  afterAll(async () => {
    await admin.close();
  });

  it('refuses to boot without keys once a module declared a column', async () => {
    await expect(boot([], [])).rejects.toThrow(
      /DATA_ENCRYPTION_KEYS is not set.*e2e_encryption_people\.national_id/,
    );
  });

  it('stores ciphertext, finds a row by value, and moves rows over after a rotation', async () => {
    const before = await boot([oldData], [oldIndex]);
    const encryption = before.get(EncryptionService);
    await db.insert(people).values({
      tenantId: TENANT,
      ...encryption.seal(people.nationalId, 'AB 123', TENANT),
    });
    const [stored] = await db.select().from(people);
    expect(stored.nationalId).not.toContain('AB 123');
    const found = await db
      .select()
      .from(people)
      .where(encryption.lookup(people.nationalId, ' AB 123 ', TENANT));
    expect(found).toHaveLength(1);
    await before.close();

    // Rotation: new keys in front, old ones kept.
    const after = await boot([key(), oldData], [key(), oldIndex]);
    const rotated = after.get(EncryptionService);
    const reencryption = after.get(ReencryptionService);
    const entry = rotated.columns()[0];
    expect(await reencryption.stale(db, entry)).toBe(1);
    // Old rows are still found, and still open.
    expect(
      await db
        .select()
        .from(people)
        .where(rotated.lookup(people.nationalId, 'AB 123', TENANT)),
    ).toHaveLength(1);

    expect(await reencryption.run(db)).toEqual({ rewritten: 1, failed: 0 });
    expect(await reencryption.run(db)).toEqual({ rewritten: 0, failed: 0 });
    const [moved] = await db
      .select()
      .from(people)
      .where(eq(people.id, stored.id));
    expect(moved.nationalId!.startsWith(rotated.currentPrefix()!)).toBe(true);
    expect(rotated.decrypt(people.nationalId, moved.nationalId, TENANT)).toBe(
      'AB 123',
    );
    expect(
      moved.nationalIdIndex!.startsWith(rotated.currentIndexPrefix()!),
    ).toBe(true);
    await after.close();
  });

  it('reports a value that does not open and leaves it alone', async () => {
    await db.delete(people);
    const moduleRef = await boot([key()], [key()]);
    const [broken] = await db
      .insert(people)
      .values({
        tenantId: TENANT,
        nationalId: 'not encrypted',
        nationalIdIndex: 'x',
      })
      .returning();
    expect(await moduleRef.get(ReencryptionService).run(db)).toEqual({
      rewritten: 0,
      failed: 1,
    });
    const [same] = await db
      .select()
      .from(people)
      .where(eq(people.id, broken.id));
    expect(same.nationalId).toBe('not encrypted');
    await moduleRef.close();
  });
});
