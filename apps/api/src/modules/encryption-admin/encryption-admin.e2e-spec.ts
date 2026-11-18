import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable, Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { encryptedNotes } from '../../../test/fixtures/encryption-admin/encryption-admin.tables.js';
import type { Database } from '../../core/database/database.js';
import { DatabaseModule } from '../../core/database/database.module.js';
import { EncryptedColumns } from '../../core/encryption/encrypted-columns.js';
import { EncryptionModule } from '../../core/encryption/encryption.module.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { SharedLocksModule } from '../../core/locks/locks.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { appSecrets } from '../../core/secrets/secrets.tables.js';
import { TenancyModule } from '../../core/tenancy/tenancy.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { RolesService } from '../../iam/access/roles.service.js';
import { EncryptionAdminModule } from './encryption-admin.module.js';

const keys = await vi.hoisted(async () => {
  const { randomBytes } = await import('node:crypto');
  const key = () => randomBytes(32).toString('base64');
  const slug = `ops-${process.pid}-${Date.now()}`;
  const old = {
    data: key(),
    index: key(),
    fresh: { data: key(), index: key() },
  };
  Object.assign(process.env, {
    SCHEDULER: 'off',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-encryption-admin-${process.pid}-${Date.now()}`,
    OPERATOR_TENANT: slug,
    // The rows are written under the old keys first (beforeAll).
    DATA_ENCRYPTION_KEYS: old.data,
    BLIND_INDEX_KEYS: old.index,
  });
  return { ...old, slug };
});

/** The module that owns the columns: it lists them, as a real one does. */
@EncryptedColumns([encryptedNotes.body, appSecrets.value])
@Injectable()
class NotesColumns {}

@Module({ providers: [NotesColumns] })
class ColumnsModule {}

type Headers = Record<string, string>;

describe('encryption admin (e2e)', () => {
  let app: NestNodeApplication;
  let operator: Headers;
  let outsider: Headers;
  let tenantA: string;

  beforeAll(async () => {
    // Under the old keys: two tenants' notes and a tenantless secret.
    const before = await bootModules(
      DatabaseModule,
      TenancyModule,
      EncryptionModule,
      ColumnsModule,
    );
    const encryption = before.get(EncryptionService);
    const db = before.get<Database>(getDrizzleToken());
    const tenancy = before.get(Tenancy);
    tenantA = (await tenancy.create({ slug: 'enc-a', name: 'A' })).id;
    const tenantB = (await tenancy.create({ slug: 'enc-b', name: 'B' })).id;
    for (const id of [tenantA, tenantB]) {
      await tenancy.run(id, () =>
        db.insert(encryptedNotes).values(
          encryption.seal(encryptedNotes.body, `secret of ${id}`, id) as {
            body: string;
            bodyIndex: string;
          },
        ),
      );
    }
    await db.insert(appSecrets).values({
      name: 'encryption-admin-test',
      value: encryption.encrypt(appSecrets.value, 'tenantless secret'),
    });
    await before.close();

    // Rotation: new keys in front, the old ones kept.
    Object.assign(process.env, {
      DATA_ENCRYPTION_KEYS: `${keys.fresh.data},${keys.data}`,
      BLIND_INDEX_KEYS: `${keys.fresh.index},${keys.index}`,
    });
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      SharedLocksModule,
      EncryptionModule,
      ColumnsModule,
      EncryptionAdminModule,
    );
    const live = app.get<Database>(getDrizzleToken());
    let [ops] = await live
      .select()
      .from(tenants)
      .where(eq(tenants.slug, keys.slug));
    if (!ops) {
      ops = await app
        .get(Tenancy)
        .create({ slug: keys.slug, name: 'Operators' });
      await app
        .get(Tenancy)
        .run(ops.id, () =>
          app
            .get(TransactionHost)
            .withTransaction(() => app.get(RolesService).seedTenantRoles()),
        );
    }
    operator = (await member(app, ops.id, ['administrator'])).headers;
    outsider = (await tenantWithAdmin(app)).admin.headers;
  });
  afterAll(() => app.close());

  const call = (method: 'GET' | 'POST', url: string, headers = operator) =>
    app.inject({ method, url, headers });

  const stale = async () => {
    const status = (await call('GET', '/v1/encryption/status')).json();
    return {
      status,
      of: (column: string) =>
        status.columns.find(
          (entry: { column: string }) => entry.column === column,
        )?.staleRows,
    };
  };

  it('is for operators only', async () => {
    const refused = await call('GET', '/v1/encryption/status', outsider);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'operator_required' });
    expect(
      (await call('POST', '/v1/encryption/reencryption', {})).statusCode,
    ).toBe(401);
  });

  it('counts the rows on an old key in every tenant, and the tenantless ones once', async () => {
    const { status, of } = await stale();
    expect(status).toMatchObject({ enabled: true, upToDate: false });
    expect(status.dataKeyId).toEqual(expect.any(String));
    expect(JSON.stringify(status)).not.toContain(keys.fresh.data);
    expect(of('test_encrypted_notes.body')).toBe(2);
    expect(of('app_secrets.value')).toBeGreaterThanOrEqual(1);
  });

  it('queues the re-encryption, which moves every row to the current key', async () => {
    const queued = await call('POST', '/v1/encryption/reencryption');
    expect(queued.statusCode).toBe(200);
    // Two tenants and the tenantless tables.
    expect(queued.json().queued).toBeGreaterThanOrEqual(3);
    await vi.waitFor(
      async () => expect((await stale()).status.upToDate).toBe(true),
      {
        timeout: 20_000,
      },
    );
    expect((await stale()).of('test_encrypted_notes.body')).toBe(0);

    // The rows still open.
    const encryption = app.get(EncryptionService);
    const db = app.get<Database>(getDrizzleToken());
    const [row] = await app
      .get(Tenancy)
      .run(tenantA, () => db.select().from(encryptedNotes));
    expect(encryption.decrypt(encryptedNotes.body, row!.body, tenantA)).toBe(
      `secret of ${tenantA}`,
    );
    // Nothing left to do: a second request queues nothing.
    expect((await call('POST', '/v1/encryption/reencryption')).json()).toEqual({
      queued: 0,
    });
  });
});
