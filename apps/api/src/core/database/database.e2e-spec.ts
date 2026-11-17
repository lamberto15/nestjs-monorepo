import { TransactionHost } from '@nestjs-cls/transactional';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq, sql } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import {
  TestItemsBatch,
  TestItemsModule,
  TestItemsService,
} from '../../../test/fixtures/test-items.js';
import { testItems } from '../../../test/fixtures/test-items.tables.js';
import { databaseErrorKind } from './database-errors.js';
import { DatabaseModule } from './database.module.js';
import type { Database, DatabaseTransactions } from './database.js';

/** Boots DatabaseModule with these variables set, and puts them back after. */
async function bootWith(env: Record<string, string>) {
  const saved = Object.fromEntries(
    Object.keys(env).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, env);
  try {
    return await bootModules(DatabaseModule, TestItemsModule);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

// One app at a time: @Transactional() reaches the TransactionHost of the
// last app booted, so each describe boots and closes its own.
describe('transactions (e2e)', () => {
  let app: NestNodeApplication;
  let items: TestItemsService;
  let batch: TestItemsBatch;
  let txHost: TransactionHost<DatabaseTransactions>;
  let db: Database;

  beforeAll(async () => {
    app = await bootModules(DatabaseModule, TestItemsModule);
    items = app.get(TestItemsService);
    batch = app.get(TestItemsBatch);
    txHost = app.get(TransactionHost);
    db = app.get(getDrizzleToken());
  });
  afterAll(() => app.close());
  beforeEach(() => db.delete(testItems));

  it('commits what another service wrote inside, without being handed tx', async () => {
    await batch.addAll(['a', 'b']);
    expect(await items.names()).toEqual(['a', 'b']);
  });

  it('rolls back what another service wrote inside', async () => {
    await expect(batch.addAll(['a', 'b'], new Error('undo'))).rejects.toThrow(
      'undo',
    );
    expect(await items.names()).toEqual([]);
  });

  it('joins the current transaction when nested: one commit, one rollback', async () => {
    await expect(
      batch.addTwice(['a'], ['b'], new Error('outer fails')),
    ).rejects.toThrow('outer fails');
    expect(await items.names()).toEqual([]);
  });

  it('runs a block in a transaction with withTransaction(), with its options', async () => {
    const isolation = await txHost.withTransaction(
      { isolationLevel: 'serializable' },
      async () => {
        await items.add('a');
        const [row] = await txHost.tx
          .select({
            level: sql<string>`current_setting('transaction_isolation')`,
          })
          .from(testItems)
          .where(eq(testItems.name, 'a'));
        return row!.level;
      },
    );
    expect(isolation).toBe('serializable');
    expect(await items.names()).toEqual(['a']);
  });

  it('leaves @InjectDrizzle() outside the transaction: its writes outlive a rollback', async () => {
    await expect(
      txHost.withTransaction(async () => {
        await items.add('inside');
        await db.insert(testItems).values({ name: 'outside' });
        throw new Error('undo');
      }),
    ).rejects.toThrow('undo');
    expect(await items.names()).toEqual(['outside']);
  });
});

describe('the pool (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;

  beforeAll(async () => {
    app = await bootWith({
      DATABASE_POOL_MAX: '1',
      DATABASE_POOL_TIMEOUT_MS: '200',
      DATABASE_STATEMENT_TIMEOUT_MS: '300',
      DATABASE_IDLE_TX_TIMEOUT_MS: '45000',
      DATABASE_APPLICATION_NAME: 'e2e-pool',
    });
    db = app.get(getDrizzleToken());
  });
  afterAll(() => app.close());

  it('connects with the configured limits and application_name', async () => {
    const result = await db.execute<{
      name: string;
      statement: string;
      idle: string;
    }>(
      sql`select current_setting('application_name') as name,
        current_setting('statement_timeout') as statement,
        current_setting('idle_in_transaction_session_timeout') as idle`,
    );
    expect(result.rows[0]).toEqual({
      name: 'e2e-pool',
      statement: '300ms',
      idle: '45s',
    });
  });

  it('reports a statement PostgreSQL cancelled as statement_timeout', async () => {
    const error = await caught(db.execute(sql`select pg_sleep(1)`));
    expect(databaseErrorKind(error)).toBe('statement_timeout');
  });

  it('reports no free connection in time as pool_exhausted, without hanging', async () => {
    const txHost =
      app.get<TransactionHost<DatabaseTransactions>>(TransactionHost);
    const error = await txHost.withTransaction(async () => {
      // The transaction holds the only connection.
      await txHost.tx.select({ one: sql`1` }).from(testItems);
      return caught(db.select().from(testItems));
    });
    expect(databaseErrorKind(error)).toBe('pool_exhausted');
  });
});

describe('database errors (e2e)', () => {
  let app: NestNodeApplication;
  let items: TestItemsService;
  let db: Database;

  beforeAll(async () => {
    app = await bootModules(DatabaseModule, TestItemsModule);
    items = app.get(TestItemsService);
    db = app.get(getDrizzleToken());
  });
  afterAll(() => app.close());
  beforeEach(() => db.delete(testItems));

  it('reports a duplicate as unique_violation', async () => {
    await items.add('a');
    expect(databaseErrorKind(await caught(items.add('a')))).toBe(
      'unique_violation',
    );
  });

  it('reports a row still referred to, or a missing one, as foreign_key_violation', async () => {
    const parent = await items.add('parent');
    await items.add('child', parent.id);
    const deleting = db.delete(testItems).where(eq(testItems.id, parent.id));
    expect(databaseErrorKind(await caught(deleting))).toBe(
      'foreign_key_violation',
    );
    expect(
      databaseErrorKind(
        await caught(
          items.add('orphan', '0190f5a0-0000-7000-8000-000000000000'),
        ),
      ),
    ).toBe('foreign_key_violation');
  });
});
