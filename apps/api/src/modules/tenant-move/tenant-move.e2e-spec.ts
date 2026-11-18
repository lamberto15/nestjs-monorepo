import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { OutboxRelay } from '@nestjs/outbox';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { StorageDisk } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import { inject } from 'vitest';
import { accessModules, tenantWithAdmin } from '../../../test/access.js';
import { CheapPasswordsModule } from '../../../test/account.js';
import { createUser, signIn } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import { encryptedNotes } from '../../../test/fixtures/encryption-admin/encryption-admin.tables.js';
import { tenantItems } from '../../../test/fixtures/tenant-items.tables.js';
import { createDatabase, databaseUrl } from '../../../test/postgres.js';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type { Database } from '../../core/database/database.js';
import { EncryptedColumns } from '../../core/encryption/encrypted-columns.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { SharedOutboxModule } from '../../core/outbox/outbox.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { CLI_PERMISSIONS, OPS_JOB } from '../../cli/cli.jobs.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AccountModule } from '../../iam/account/account.module.js';
import { memberships, users } from '../../iam/auth/auth.tables.js';
import { HoldsModule } from '../../iam/holds/holds.module.js';
import { PersonalDataModule } from '../../iam/personal-data/personal-data.module.js';
import { TenantsModule } from '../../iam/tenants/tenants.module.js';
import { userAvatars } from '../attachments/avatars/avatars.tables.js';
import { StorageModule } from '../storage/storage.module.js';
import { accountFileKey, tenantFileKey } from '../storage/storage.keys.js';
import { archiveKey, readManifest, writeManifest } from './move-archive.js';
import { TenantMoveModule } from './tenant-move.module.js';
import { MoveRefused, TenantMoveService } from './tenant-move.service.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    OUTBOX_RELAY: 'off',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'local',
    MAIL_TRANSPORT: 'memory',
    PASSWORD_BREACH_CHECK: 'off',
    OPERATOR_TENANT: `ops-${process.pid}-${Date.now()}`,
    REDIS_PREFIX: `test-tenant-move-${process.pid}-${Date.now()}`,
  });
});

/** The fixture's encrypted column, declared as a module declares its own. */
@EncryptedColumns([encryptedNotes.body])
@Injectable()
class EncryptedNotesColumns {}

@Module({
  imports: [
    // The operator CLI's job: the actor of every step of a move.
    AccessModule.forFeature(CLI_PERMISSIONS),
  ],
  providers: [EncryptedNotesColumns],
})
class MoveTestModule {}

const key32 = () => randomBytes(32).toString('base64');
const SOURCE_KEYS = { data: key32(), index: key32() };
const TARGET_KEYS = { data: key32(), index: key32() };

interface Server {
  database: {
    DATABASE_URL: string;
    DATABASE_OWNER_URL: string;
    DATABASE_MAINTENANCE_URL: string;
  };
  tenancy: 'multi' | 'single';
  keys: { data: string; index: string };
  root: string;
  seed: 'on' | 'off';
}

/** The database variables of a fresh copy of the migrated template, as setup-env.ts makes the file's own. */
async function freshDatabase() {
  const made = await createDatabase(
    inject('postgresUrl'),
    inject('databasePrefix'),
    inject('templateDatabase'),
    inject('ownerRole'),
  );
  return {
    drop: made.drop,
    variables: {
      DATABASE_URL: databaseUrl(inject('appUrl'), made.name),
      DATABASE_OWNER_URL: databaseUrl(inject('ownerUrl'), made.name),
      DATABASE_MAINTENANCE_URL: databaseUrl(
        inject('maintenanceUrl'),
        made.name,
      ),
    },
  };
}

/** One server of the move: its database, tenancy, keys and disk, booted with what a move uses. */
function boot(server: Server) {
  Object.assign(process.env, {
    ...server.database,
    TENANCY: server.tenancy,
    DATA_ENCRYPTION_KEYS: server.keys.data,
    BLIND_INDEX_KEYS: server.keys.index,
    STORAGE_ROOT: server.root,
    FIRST_START_SEED: server.seed,
  });
  return bootModules(
    ...accessModules(),
    QueuesModule,
    SharedOutboxModule,
    StorageModule,
    TenantsModule,
    AccountModule,
    HoldsModule,
    PersonalDataModule,
    CheapPasswordsModule,
    MoveTestModule,
    TenantMoveModule,
  );
}

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * A tenant moves from a shared server to one of its own: frozen, exported,
 * imported into a fresh single-tenant server (and a multi-tenant one),
 * verified, and erased from the source.
 */
describe('tenant move (e2e)', () => {
  let app: NestNodeApplication | undefined;
  const dropped: (() => Promise<void>)[] = [];
  let source: Server;
  let single: Server;
  let multi: Server;
  let archive: string;
  let keyText: string;

  // What the source holds, checked on the targets.
  let tenantId: string;
  let slug: string;
  let other: { tenantId: string };
  let admin: { id: string; email: string };
  let shared: { id: string; email: string };
  const big = randomBytes(200_000);
  const avatar = randomBytes(5_000);
  let fileKey: string;
  let avatarKey: string;
  let oldExportKey: string;
  let otherFileKey: string;

  const db = () => app!.get<Database>(getDrizzleToken());
  const moves = () => app!.get(TenantMoveService);
  const actor = () => app!.get(SystemContext).principal(OPS_JOB);
  const inTenant = <T>(id: string, work: () => Promise<T>) =>
    app!.get(Tenancy).run(id, work);
  const global = <T>(work: () => Promise<T>) =>
    app!.get(Tenancy).run(null, work);
  const read = (key: string) => app!.get(StorageDisk).getBuffer(key);
  const relay = async () => {
    await app!.get(OutboxRelay).runOnce();
    await app!.get(OutboxRelay).runOnce();
  };

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenant-move-e2e-'));
    dropped.push(() => rm(root, { recursive: true, force: true }));
    archive = join(root, 'archive');
    source = {
      database: {
        DATABASE_URL: process.env.DATABASE_URL!,
        DATABASE_OWNER_URL: process.env.DATABASE_OWNER_URL!,
        DATABASE_MAINTENANCE_URL: process.env.DATABASE_MAINTENANCE_URL!,
      },
      tenancy: 'multi',
      keys: SOURCE_KEYS,
      root: join(root, 'source-disk'),
      seed: 'on',
    };
    const singleDb = await freshDatabase();
    const multiDb = await freshDatabase();
    dropped.push(singleDb.drop, multiDb.drop);
    single = {
      database: singleDb.variables,
      tenancy: 'single',
      keys: TARGET_KEYS,
      root: join(root, 'single-disk'),
      seed: 'off',
    };
    multi = {
      database: multiDb.variables,
      tenancy: 'multi',
      keys: TARGET_KEYS,
      root: join(root, 'multi-disk'),
      seed: 'on',
    };
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  afterAll(async () => {
    for (const drop of dropped) await drop();
  });

  it('exports a frozen tenant from the source, and refuses its writes while frozen', async () => {
    app = await boot(source);
    const made = await tenantWithAdmin(app);
    tenantId = made.tenantId;
    admin = made.admin;
    other = await tenantWithAdmin(app);
    slug = (await app.get(Tenancy).find(tenantId))!.slug;
    // An account of the other tenant, also a member of this one.
    const sharedUser = await createUser(app, { tenantId: other.tenantId });
    shared = { id: sharedUser.user.id, email: sharedUser.email };
    await global(() =>
      db().insert(memberships).values({ tenantId, userId: shared.id }),
    );
    const encryption = app.get(EncryptionService);
    await inTenant(tenantId, async () => {
      await db()
        .insert(encryptedNotes)
        .values(
          encryption.seal(encryptedNotes.body, 'tax 123', tenantId) as {
            body: string;
            bodyIndex: string;
          },
        );
      const [parent] = await db()
        .insert(tenantItems)
        .values({ name: 'parent' })
        .returning();
      await db()
        .insert(tenantItems)
        .values({ name: 'child', parentId: parent!.id });
    });
    const disk = app.get(StorageDisk);
    fileKey = tenantFileKey(tenantId, 'attachments/big.bin');
    avatarKey = accountFileKey(admin.id, 'avatar/me.png');
    oldExportKey = accountFileKey(admin.id, 'exports/old.json');
    otherFileKey = tenantFileKey(other.tenantId, 'attachments/theirs.bin');
    await disk.put(fileKey, big, { contentType: 'application/octet-stream' });
    await disk.put(avatarKey, avatar, { contentType: 'image/png' });
    await disk.put(oldExportKey, '{}');
    await disk.put(otherFileKey, 'theirs');
    await global(() =>
      db().insert(userAvatars).values({ userId: admin.id, key: avatarKey }),
    );

    // Not frozen: no export.
    await expect(
      moves().export(actor(), tenantId, archive),
    ).rejects.toBeInstanceOf(MoveRefused);

    // Signed in before: a sign-in writes its audit entry in the tenant, refused while frozen.
    const { headers } = await signIn(app, admin.email);
    await moves().freeze(actor(), tenantId, true);
    // Every write of the tenant is refused by the database; its reads go on.
    const write = inTenant(tenantId, () =>
      db().insert(tenantItems).values({ name: 'late' }),
    );
    await expect(write).rejects.toSatisfy(
      (error) => databaseErrorKind(error) === 'read_only',
    );
    // A new sign-in into it is audited there: refused too.
    await expect(signIn(app, admin.email)).rejects.toThrow('503');
    const role = await app.inject({
      method: 'POST',
      url: '/v1/access/roles',
      headers,
      payload: { name: 'late', permissions: [] },
    });
    expect(role.statusCode).toBe(503);
    expect(role.json()).toMatchObject({ code: 'tenant_read_only' });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/access/roles', headers }))
        .statusCode,
    ).toBe(200);
    // Another tenant is not frozen.
    await inTenant(other.tenantId, () =>
      db().insert(tenantItems).values({ name: 'still writable' }),
    );

    const exported = await moves().export(actor(), tenantId, archive);
    keyText = exported.key;
    const { manifest } = exported;
    expect(manifest.tenant).toMatchObject({ id: tenantId, slug });
    expect(manifest.files.map((file) => file.key).sort()).toEqual(
      [avatarKey, fileKey].sort(),
    );
    expect(manifest.files.find((f) => f.key === fileKey)).toMatchObject({
      size: big.length,
      sha256: sha256(big),
    });
    expect(
      manifest.accounts.find((a) => a.id === shared.id)?.elsewhere,
    ).toEqual([(await app.get(Tenancy).find(other.tenantId))!.slug]);
    expect(manifest.accounts.find((a) => a.id === admin.id)?.elsewhere).toEqual(
      [],
    );
    const rowsOf = (name: string) =>
      manifest.tables.find((table) => table.name === name)?.rows;
    expect(rowsOf('test_tenant_items')).toBe(2);
    expect(rowsOf('test_encrypted_notes')).toBe(1);
    expect(rowsOf('memberships')).toBe(2);
    expect(rowsOf('user_avatars')).toBe(1);
    expect(rowsOf('sessions')).toBeUndefined();
    expect(
      manifest.tables.find((t) => t.name === 'test_encrypted_notes')?.encrypted,
    ).toEqual(['body']);
    // Written once: an archive is never overwritten.
    await expect(moves().export(actor(), tenantId, archive)).rejects.toThrow(
      'not empty',
    );
  });

  it('imports into a fresh single-tenant server: the one tenant, verified, its people signing in with their passwords', async () => {
    app = await boot(single);
    expect(await global(() => db().select().from(tenants))).toEqual([]);

    const imported = await moves().import(actor(), archive, keyText);
    expect(imported).toMatchObject({ alreadyHere: false, copiedFiles: 2 });
    expect((await app.get(Tenancy).soleTenant()).id).toBe(tenantId);

    // The encrypted note opens with this server's keys, under a key of its own, and is found by its new blind index.
    const encryption = app.get(EncryptionService);
    const [note] = await inTenant(tenantId, () =>
      db()
        .select()
        .from(encryptedNotes)
        .where(encryption.lookup(encryptedNotes.body, 'tax 123', tenantId)),
    );
    expect(encryption.decrypt(encryptedNotes.body, note!.body, tenantId)).toBe(
      'tax 123',
    );
    expect(encryption.keyIdOf(note!.body)).toBe(encryption.currentKeyId);
    const items = await inTenant(tenantId, () =>
      db().select().from(tenantItems),
    );
    expect(items.map((item) => item.name).sort()).toEqual(['child', 'parent']);

    expect((await read(fileKey)).equals(big)).toBe(true);
    expect((await read(avatarKey)).equals(avatar)).toBe(true);
    expect(await app.get(StorageDisk).exists(oldExportKey)).toBe(false);
    expect(await app.get(StorageDisk).exists(otherFileKey)).toBe(false);

    // The shared account is a copy here, a member of this tenant only.
    expect(
      await global(() =>
        db()
          .select({ tenantId: memberships.tenantId })
          .from(memberships)
          .where(eq(memberships.userId, shared.id)),
      ),
    ).toEqual([{ tenantId }]);

    // Again: nothing inserted twice, the tenant verified.
    expect(await moves().import(actor(), archive, keyText)).toMatchObject({
      alreadyHere: true,
      copiedFiles: 0,
    });
    // A file lost after the import: the next run puts it back.
    await app.get(StorageDisk).delete(fileKey);
    expect(await moves().import(actor(), archive, keyText)).toMatchObject({
      alreadyHere: true,
      copiedFiles: 1,
    });
    expect(
      (await inTenant(tenantId, () => db().select().from(tenantItems))).length,
    ).toBe(2);
    // Its people sign in with the passwords they had (no session came along).
    await signIn(app, admin.email);
    await signIn(app, shared.email);
    // Changed since (a sign-in is audited): refused, never overwritten.
    await inTenant(tenantId, () =>
      db().insert(tenantItems).values({ name: 'new here' }),
    );
    await expect(moves().import(actor(), archive, keyText)).rejects.toThrow(
      'already here and differs',
    );

    // A wrong key, and an archive of another schema, are refused.
    await expect(
      moves().inspect(archive, keyText.slice(0, -2) + 'AA'),
    ).rejects.toBeInstanceOf(MoveRefused);
    const manifest = await readManifest(archive, archiveKey(keyText));
    const elsewhere = join(archive, '..', 'other-release');
    await mkdir(elsewhere);
    await writeManifest(elsewhere, archiveKey(keyText), {
      ...manifest,
      schema: { latest: '20990101000000_later', digest: 'other' },
    });
    const { problems } = await moves().inspect(elsewhere, keyText);
    expect(problems).toEqual([expect.stringContaining('20990101000000_later')]);
    await expect(moves().import(actor(), elsewhere, keyText)).rejects.toThrow(
      'same release',
    );
    await app.close();

    // Its first real start makes no other tenant and no administrator.
    app = await boot({ ...single, seed: 'on' });
    expect(
      (await global(() => db().select({ id: tenants.id }).from(tenants))).map(
        (t) => t.id,
      ),
    ).toEqual([tenantId]);
    expect((await app.get(Tenancy).soleTenant()).id).toBe(tenantId);
  });

  it('imports into a multi-tenant server that lacks it, refusing a slug or an address already there', async () => {
    app = await boot(multi);
    const taken = await app.get(Tenancy).create({ slug, name: 'Taken' });
    const clash = await createUser(app, { email: shared.email });
    const { problems } = await moves().inspect(archive, keyText);
    expect(problems).toEqual([
      `A tenant here already has the slug "${slug}".`,
      `${shared.email} already has an account here.`,
    ]);
    await expect(moves().import(actor(), archive, keyText)).rejects.toThrow(
      'already has an account here',
    );
    await global(async () => {
      await db().delete(tenants).where(eq(tenants.id, taken.id));
      await db().delete(tenants).where(eq(tenants.id, clash.tenantId));
      await db().delete(users).where(eq(users.id, clash.user.id));
    });

    expect(await moves().import(actor(), archive, keyText)).toMatchObject({
      alreadyHere: false,
    });
    await signIn(app, admin.email);
    expect((await read(fileKey)).equals(big)).toBe(true);
  });

  it('erases the moved tenant from the source with its files, once asked; accounts are deleted only with eraseAccounts, never one in another tenant', async () => {
    app = await boot(source);
    const disk = app.get(StorageDisk);
    const accountOf = (id: string) =>
      global(async () => {
        const [row] = await db()
          .select({ email: users.email, passwordHash: users.passwordHash })
          .from(users)
          .where(eq(users.id, id));
        return row;
      });
    const tenantsOf = (id: string) =>
      global(() =>
        db()
          .select({ tenantId: memberships.tenantId })
          .from(memberships)
          .where(eq(memberships.userId, id)),
      );
    // Only a frozen tenant: one thawed may have changed since its export.
    await expect(
      moves().finish(actor(), other.tenantId),
    ).rejects.toBeInstanceOf(MoveRefused);

    expect(await moves().finishing(tenantId)).toMatchObject({
      accounts: 2,
      onlyHere: [{ id: admin.id, email: admin.email }],
    });
    // Without eraseAccounts: the tenant goes, its accounts stay.
    const finished = await moves().finish(actor(), tenantId);
    expect(finished).toMatchObject({
      accounts: [{ id: admin.id }],
      erased: [],
    });
    expect(await app.get(Tenancy).find(tenantId)).toBeUndefined();
    await relay();
    expect(await disk.exists(fileKey)).toBe(false);
    expect(await disk.exists(otherFileKey)).toBe(true);
    expect(await accountOf(admin.id)).toMatchObject({ email: admin.email });
    expect((await accountOf(admin.id))!.passwordHash).not.toBeNull();
    expect(await disk.exists(avatarKey)).toBe(true);
    expect(await tenantsOf(shared.id)).toEqual([{ tenantId: other.tenantId }]);

    // Later, the account left in no tenant; never one still in a tenant.
    await expect(moves().eraseAccount(actor(), shared.email)).rejects.toThrow(
      'still belongs to a tenant',
    );
    expect(await moves().eraseAccount(actor(), admin.email)).toBe(true);
    await relay();
    expect((await accountOf(admin.id))!.email).toBe(
      `deleted-${admin.id}@anonymized.invalid`,
    );
    expect(await disk.exists(avatarKey)).toBe(false);
    expect(await disk.exists(oldExportKey)).toBe(false);

    // With eraseAccounts: a second moved tenant's only member is deleted
    // (rows, and their files by the storage release); the shared one stays.
    const third = await tenantWithAdmin(app);
    await global(() =>
      db()
        .insert(memberships)
        .values({ tenantId: third.tenantId, userId: shared.id }),
    );
    const lonelyFile = accountFileKey(third.admin.id, 'avatar/me.png');
    await disk.put(lonelyFile, avatar, { contentType: 'image/png' });
    await moves().freeze(actor(), third.tenantId, true);
    const erasing = await moves().finish(
      actor(),
      third.tenantId,
      {},
      {
        eraseAccounts: true,
      },
    );
    expect(erasing).toMatchObject({
      accounts: [{ id: third.admin.id }],
      erased: [third.admin.email],
      held: [],
    });
    await relay();
    expect(await accountOf(third.admin.id)).toMatchObject({
      email: `deleted-${third.admin.id}@anonymized.invalid`,
      passwordHash: null,
    });
    expect(await tenantsOf(third.admin.id)).toEqual([]);
    expect(await disk.exists(lonelyFile)).toBe(false);
    expect(await accountOf(shared.id)).toMatchObject({ email: shared.email });
    expect(await tenantsOf(shared.id)).toEqual([{ tenantId: other.tenantId }]);
  });
});
