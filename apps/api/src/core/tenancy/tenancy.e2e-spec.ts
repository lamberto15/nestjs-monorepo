import { TransactionHost } from '@nestjs-cls/transactional';
import { Logger } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq, sql } from 'drizzle-orm';
import { CLS_REQ, ClsService } from 'nestjs-cls';
import { Client, type Pool, type PoolClient } from 'pg';
import { inject } from 'vitest';
import { bootModules } from '../../../test/boot.js';
import {
  TenantItemsModule,
  TenantItemsService,
} from '../../../test/fixtures/tenant-items.js';
import { tenantItems } from '../../../test/fixtures/tenant-items.tables.js';
import { FIXTURE_MIGRATIONS } from '../../../test/fixtures/test-items.tables.js';
import { createDatabase, databaseUrl } from '../../../test/postgres.js';
import { databaseErrorKind } from '../database/database-errors.js';
import { DatabaseModule } from '../database/database.module.js';
import type { Database } from '../database/database.js';
import { MIGRATIONS_FOLDER, migrateAll } from '../database/migrations.js';
import { EncryptionTenant } from '../encryption/encryption.service.js';
import { TenancyModule } from './tenancy.module.js';
import { tenants } from './tenancy.tables.js';
import { Tenancy, TenantRunsFailed } from './tenancy.service.js';
import { TenantScopeMissingError } from './tenant-scope.js';

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

/** The error a database refused with: Drizzle wraps it in `cause`. */
const codeOf = (error: unknown) =>
  (error as { cause?: { code?: string }; code?: string }).cause?.code ??
  (error as { code?: string }).code;

/**
 * The tenant wall: row-level security proven as the app's role in SQL, then
 * through the app (Drizzle, transactions, the pool's reused connections,
 * requests, work across tenants). One connection in the pool, so every use
 * below reuses the one the use before left.
 */
describe('tenancy (e2e)', () => {
  let app: NestNodeApplication;
  let tenancy: Tenancy;
  let items: TenantItemsService;
  let db: Database;
  let a: string;
  let b: string;

  beforeAll(async () => {
    process.env.DATABASE_POOL_MAX = '1';
    try {
      app = await bootModules(DatabaseModule, TenancyModule, TenantItemsModule);
    } finally {
      delete process.env.DATABASE_POOL_MAX;
    }
    tenancy = app.get(Tenancy);
    items = app.get(TenantItemsService);
    db = app.get(getDrizzleToken());
    a = (await tenancy.create({ slug: 'a', name: 'A' })).id;
    b = (await tenancy.create({ slug: 'b', name: 'B' })).id;
  });
  afterAll(() => app.close());
  beforeEach(() =>
    tenancy.acrossTenants('test cleanup', () => db.delete(tenantItems)),
  );

  /** One row in each tenant. */
  async function itemInEach() {
    const mine = await tenancy.run(a, () => items.add('a1'));
    const theirs = await tenancy.run(b, () => items.add('b1'));
    return { mine: mine.id, theirs: theirs.id };
  }

  describe('as the app role, in SQL', () => {
    it('shows no row of another tenant, and refuses to write one', async () => {
      const { mine, theirs } = await itemInEach();
      const sqlApp = new Client({ connectionString: process.env.DATABASE_URL });
      await sqlApp.connect();
      try {
        // No setting at all: nothing to read, nothing to write.
        expect(
          (await sqlApp.query('select id from test_tenant_items')).rows,
        ).toEqual([]);
        await expect(
          sqlApp.query(
            `insert into test_tenant_items (tenant_id, name) values ($1, 'x')`,
            [a],
          ),
        ).rejects.toMatchObject({ code: '42501' });

        await sqlApp.query('begin');
        await sqlApp.query(`select set_config('app.tenant_id', $1, true)`, [a]);
        const read = await sqlApp.query<{ id: string }>(
          'select id from test_tenant_items',
        );
        expect(read.rows.map((row) => row.id)).toEqual([mine]);
        expect(
          (
            await sqlApp.query(
              'select id from test_tenant_items where id = $1',
              [theirs],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await sqlApp.query(
              `update test_tenant_items set name = 'stolen' where id = $1`,
              [theirs],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await sqlApp.query('delete from test_tenant_items where id = $1', [
              theirs,
            ])
          ).rowCount,
        ).toBe(0);
        await sqlApp.query('savepoint elsewhere');
        await expect(
          sqlApp.query(
            `insert into test_tenant_items (tenant_id, name) values ($1, 'smuggled')`,
            [b],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await sqlApp.query('rollback to savepoint elsewhere');
        // Nor may a row move to it.
        await expect(
          sqlApp.query(
            'update test_tenant_items set tenant_id = $1 where id = $2',
            [b, mine],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await sqlApp.query('rollback');

        // The role is bound by the policies, and owns nothing.
        const role = await sqlApp.query(
          `select rolsuper, rolbypassrls,
                  (select count(*)::int from pg_class where relowner = current_user::regrole) as owned
           from pg_roles where rolname = current_user`,
        );
        expect(role.rows).toEqual([
          { rolsuper: false, rolbypassrls: false, owned: 0 },
        ]);
      } finally {
        await sqlApp.end();
      }
      expect(await tenancy.run(b, () => items.names())).toEqual(['b1']);
    });

    it('binds the owner too (FORCE): without a tenant it reads nothing', async () => {
      await itemInEach();
      const owner = new Client({
        connectionString: process.env.DATABASE_OWNER_URL,
      });
      await owner.connect();
      try {
        expect(
          (await owner.query('select id from test_tenant_items')).rows,
        ).toEqual([]);
        const forced = await owner.query(
          `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'test_tenant_items'`,
        );
        expect(forced.rows).toEqual([
          { relrowsecurity: true, relforcerowsecurity: true },
        ]);
      } finally {
        await owner.end();
      }
    });
  });

  describe('through the app', () => {
    it('reads and writes only the scope’s tenant, with no where clause', async () => {
      await itemInEach();
      expect(await tenancy.run(a, () => items.names())).toEqual(['a1']);
      expect(await tenancy.run(b, () => items.names())).toEqual(['b1']);
      // @InjectDrizzle(), outside any transaction, is bound the same way.
      expect(
        await tenancy.run(a, () =>
          db.select({ name: tenantItems.name }).from(tenantItems),
        ),
      ).toEqual([{ name: 'a1' }]);
      // An update with no where clause touches its tenant's rows alone.
      await tenancy.run(a, () =>
        db.update(tenantItems).set({ name: 'renamed' }),
      );
      expect(await tenancy.run(b, () => items.names())).toEqual(['b1']);
      // A read answers before its commit; the one connection is given back
      // after it, so reads of both tenants in a burst each see their own.
      const burst = await Promise.all(
        [a, b, a, b, a].map((tenant) =>
          tenancy.run(tenant, () =>
            db.select({ name: tenantItems.name }).from(tenantItems),
          ),
        ),
      );
      expect(burst.map((rows) => rows.map(({ name }) => name))).toEqual([
        ['renamed'],
        ['b1'],
        ['renamed'],
        ['b1'],
        ['renamed'],
      ]);
    });

    it('without a tenant, shows no row and refuses every write', async () => {
      const { theirs } = await itemInEach();
      expect(await items.names()).toEqual([]);
      expect(await db.select().from(tenantItems)).toEqual([]);
      // An insert that leaves the tenant out has none to take…
      const missing = await caught(items.add('x'));
      expect(missing).toBeInstanceOf(TenantScopeMissingError);
      // …and one that names a tenant is refused by the wall.
      const named = await caught(
        db.insert(tenantItems).values({ tenantId: a, name: 'x' }),
      );
      expect(codeOf(named)).toBe('42501');
      expect((await db.update(tenantItems).set({ name: 'x' })).rowCount).toBe(
        0,
      );
      expect(
        (await db.delete(tenantItems).where(eq(tenantItems.id, theirs)))
          .rowCount,
      ).toBe(0);
      expect(await tenancy.run(b, () => items.names())).toEqual(['b1']);
    });

    it("can't refer to another tenant's row (composite keys)", async () => {
      const { theirs } = await itemInEach();
      const error = await caught(
        tenancy.run(a, () => items.add('child', theirs)),
      );
      expect(databaseErrorKind(error)).toBe('foreign_key_violation');
      const parent = await tenancy.run(a, () => items.add('parent'));
      await tenancy.run(a, () => items.add('child', parent.id));
    });

    it('keeps a transaction in the scope it began in', async () => {
      const txHost = app.get(TransactionHost);
      const seen = await tenancy.run(a, () =>
        txHost.withTransaction(async () => {
          await items.add('a2');
          return items.names();
        }),
      );
      expect(seen).toEqual(['a2']);
      await expect(
        tenancy.run(a, () =>
          txHost.withTransaction(() => tenancy.run(b, () => items.names())),
        ),
      ).rejects.toThrow(/must start its own, outside it/);
      // The same tenant's work joins it.
      expect(
        await tenancy.run(a, () =>
          txHost.withTransaction(() => tenancy.run(a, () => items.names())),
        ),
      ).toEqual(['a2']);
    });

    it('never carries a scope over on a pooled connection', async () => {
      await itemInEach();
      const txHost = app.get(TransactionHost);
      const probe = () =>
        db.execute<{ pid: number; tenant: string }>(
          sql`select pg_backend_pid() as pid, coalesce(current_setting('app.tenant_id', true), '') as tenant`,
        );
      const [first] = (await tenancy.run(a, probe)).rows;
      expect(first!.tenant).toBe(a);
      // The same (only) connection, next: no tenant, then the other one.
      const [none] = (await probe()).rows;
      expect(none).toEqual({ pid: first!.pid, tenant: '' });
      expect(await items.names()).toEqual([]);
      expect(await tenancy.run(b, () => items.names())).toEqual(['b1']);
      // After a rollback too.
      await caught(
        tenancy.run(a, () =>
          txHost.withTransaction(async () => {
            await items.names();
            throw new Error('undo');
          }),
        ),
      );
      expect((await probe()).rows[0]).toEqual({ pid: first!.pid, tenant: '' });
      expect(await txHost.withTransaction(() => items.names())).toEqual([]);

      // A connection handed back inside a transaction is closed, not reused.
      const pool = (db as unknown as { $client: Pool }).$client;
      await tenancy.run(a, async () => {
        const client: PoolClient = await pool.connect();
        await client.query('begin');
        client.release();
      });
      const [after] = (await probe()).rows;
      expect(after!.pid).not.toBe(first!.pid);
      expect(after!.tenant).toBe('');
    });

    it('enters a request’s tenant once, and only one', async () => {
      const cls = app.get(ClsService);
      await cls.run(async () => {
        tenancy.enter(a);
        tenancy.enter(a);
        expect(() => tenancy.enter(b)).toThrow(/already runs as tenant/);
        expect(await items.names()).toEqual([]);
      });
      expect(() => tenancy.enter(a)).toThrow(/needs a context/);
    });

    it('enters a tenant read only: its rows, and the database refuses every write', async () => {
      await itemInEach();
      const cls = app.get(ClsService);
      const txHost = app.get(TransactionHost);
      const pool = (db as unknown as { $client: Pool }).$client;
      const refused = async (work: () => Promise<unknown>) =>
        codeOf(await caught(work()));
      await cls.run(async () => {
        tenancy.enter(a, { readOnly: true });
        // Entered again as a writer (another guard): it stays read only.
        tenancy.enter(a);
        expect(tenancy.current()).toMatchObject({
          tenantId: a,
          readOnly: true,
        });
        expect(() => tenancy.enter(b)).toThrow(/already runs as tenant/);
        expect(await items.names()).toEqual(['a1']);
        expect(await txHost.withTransaction(() => items.names())).toEqual([
          'a1',
        ]);
        // 25006: read_only_sql_transaction, outside and inside a transaction.
        expect(await refused(() => items.add('x'))).toBe('25006');
        expect(
          await refused(() => txHost.withTransaction(() => items.add('x'))),
        ).toBe('25006');
        expect(
          await refused(() => db.update(tenantItems).set({ name: 'x' })),
        ).toBe('25006');
        // A global table too, and work nested in it, whatever its tenant.
        expect(
          await refused(() =>
            db.insert(tenants).values({ slug: 'ro', name: 'RO' }),
          ),
        ).toBe('25006');
        expect(await refused(() => tenancy.run(b, () => items.add('x')))).toBe(
          '25006',
        );
        expect(
          await refused(() =>
            tenancy.run(null, () =>
              db.insert(tenants).values({ slug: 'ro', name: 'RO' }),
            ),
          ),
        ).toBe('25006');
        // A transaction can't be made read-write again.
        expect(
          await refused(() =>
            db.transaction(async (tx) => {
              await tx.execute(sql`set transaction read write`);
            }),
          ),
        ).toBe('25001');
        // A connection of its own runs nothing outside a transaction.
        const client = await pool.connect();
        try {
          await expect(client.query('select 1')).rejects.toThrow(
            /read-only scope/,
          );
        } finally {
          client.release();
        }
        expect(() =>
          tenancy.acrossTenants('test', () => items.names()),
        ).toThrow(/never runs in a request/);
      });
      // Nothing was written, and nothing carries over to the next use.
      expect(await tenancy.run(a, () => items.names())).toEqual(['a1']);
      expect(await tenancy.run(b, () => items.names())).toEqual(['b1']);
      await tenancy.run(a, () => items.add('a2'));
      expect(
        await db.select().from(tenants).where(eq(tenants.slug, 'ro')),
      ).toEqual([]);
    });
  });

  describe('requests', () => {
    const list = (tenant?: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/tenant-items',
        headers: tenant ? { 'x-test-tenant': tenant } : {},
      });

    it('runs the rest of a request in the tenant its guard entered, each request its own', async () => {
      await itemInEach();
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, i) => list([a, b, undefined][i % 3])),
      );
      responses.forEach((response, i) => {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ names: [['a1'], ['b1'], []][i % 3] });
      });
    });

    it('answers a write without a tenant with 403 tenant_required', async () => {
      const refused = await app.inject({
        method: 'POST',
        url: '/v1/tenant-items',
        payload: { name: 'x' },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'tenant_required' });
      const made = await app.inject({
        method: 'POST',
        url: '/v1/tenant-items',
        headers: { 'x-test-tenant': b },
        payload: { name: 'b2' },
      });
      expect(made.statusCode).toBe(201);
      expect(made.json()).toMatchObject({ tenantId: b, name: 'b2' });
    });
  });

  describe('work over tenants', () => {
    it('walks every active tenant, each in its scope, and names the ones that failed', async () => {
      await itemInEach();
      const seen = await tenancy.forEachTenant('test', () => items.names());
      expect(Object.fromEntries(seen)).toEqual({ [a]: ['a1'], [b]: ['b1'] });
      const ran: string[] = [];
      const error = await caught(
        tenancy.forEachTenant('test', async (tenant) => {
          ran.push(tenant.slug);
          if (tenant.id === a) throw new Error('boom');
        }),
      );
      expect(error).toBeInstanceOf(TenantRunsFailed);
      expect((error as Error).message).toMatch(/a \(boom\)/);
      expect(ran).toEqual(['a', 'b']);
    });

    it("logs a job's first run across every tenant, and its repeats at debug", async () => {
      const log = vi.spyOn(Logger.prototype, 'log');
      const debug = vi.spyOn(Logger.prototype, 'debug');
      try {
        for (let run = 0; run < 3; run++) {
          await tenancy.acrossTenants('test-logged', async () => undefined);
        }
        const line = 'test-logged: across every tenant (the maintenance role)';
        expect(log.mock.calls.filter(([m]) => m === line)).toHaveLength(1);
        expect(debug.mock.calls.filter(([m]) => m === line)).toHaveLength(2);
      } finally {
        log.mockRestore();
        debug.mockRestore();
      }
    });

    it('works across every tenant as the maintenance role, never in a request', async () => {
      await itemInEach();
      const across = await tenancy.acrossTenants('test', async () => ({
        names: (
          await db
            .select({ name: tenantItems.name })
            .from(tenantItems)
            .orderBy(tenantItems.name)
        ).map((row) => row.name),
        role: (
          await db.execute<{ role: string }>(sql`select current_user as role`)
        ).rows[0]!.role,
      }));
      expect(across).toEqual({
        names: ['a1', 'b1'],
        role: expect.stringMatching(/_maint$/),
      });
      // Back as the app role, in a tenant.
      expect(await tenancy.run(a, () => items.names())).toEqual(['a1']);
      const cls = app.get(ClsService);
      await cls.run(async () => {
        cls.set(CLS_REQ, {});
        expect(() =>
          tenancy.acrossTenants('test', () => items.names()),
        ).toThrow(/never runs in a request/);
      });
    });
  });

  it('gives core/encryption the current tenant', async () => {
    const current = app.get(EncryptionTenant);
    expect(current.current()).toBeUndefined();
    expect(await tenancy.run(a, async () => current.current())).toBe(a);
  });
});

// Each test migrates a database of its own, several times.
describe('the wall at migrate (e2e)', { timeout: 60_000 }, () => {
  async function migrated() {
    const database = await createDatabase(
      inject('postgresUrl'),
      inject('databasePrefix'),
      undefined,
      inject('ownerRole'),
    );
    const urls = {
      ownerUrl: databaseUrl(inject('ownerUrl'), database.name),
      appUrl: databaseUrl(inject('appUrl'), database.name),
      maintenanceUrl: databaseUrl(inject('maintenanceUrl'), database.name),
    };
    const migrations = [
      { migrationsFolder: MIGRATIONS_FOLDER },
      FIXTURE_MIGRATIONS,
    ];
    const migrate = () => migrateAll(urls, { migrations });
    await migrate();
    const owner = new Client({ connectionString: urls.ownerUrl });
    await owner.connect();
    return {
      migrate,
      owner,
      close: async () => {
        await owner.end();
        await database.drop();
      },
    };
  }

  it('forces row-level security again, and refuses a policy changed by hand or a table without its wall', async () => {
    const { migrate, owner, close } = await migrated();
    try {
      await owner.query(
        'alter table test_tenant_items no force row level security',
      );
      await migrate();
      const { rows } = await owner.query(
        `select relforcerowsecurity as forced from pg_class where relname = 'test_tenant_items'`,
      );
      expect(rows).toEqual([{ forced: true }]);

      await owner.query(
        'alter policy test_tenant_items_tenant_select on test_tenant_items using (true)',
      );
      await expect(migrate()).rejects.toThrow(
        /test_tenant_items \(policy test_tenant_items_tenant_select differs \(using\)\)/,
      );
      await owner.query(
        `alter policy test_tenant_items_tenant_select on test_tenant_items
         using (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))`,
      );
      // The same expression, written differently, passes.
      await migrate();

      await owner.query('create table loose (id int, tenant_id uuid)');
      await expect(migrate()).rejects.toThrow(
        /loose \(row-level security off, not forced, missing policy loose_tenant_delete/,
      );
    } finally {
      await close();
    }
  });

  it('refuses an app role that is the owner', async () => {
    const database = await createDatabase(
      inject('postgresUrl'),
      inject('databasePrefix'),
      undefined,
      inject('ownerRole'),
    );
    try {
      const ownerUrl = databaseUrl(inject('ownerUrl'), database.name);
      await expect(migrateAll({ ownerUrl, appUrl: ownerUrl })).rejects.toThrow(
        /both connect as/,
      );
    } finally {
      await database.drop();
    }
  });
});
