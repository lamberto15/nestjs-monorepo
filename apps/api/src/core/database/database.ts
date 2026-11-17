import type { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * The database, Drizzle on node-postgres. Services take it with
 * `@InjectTransaction() private readonly db: Database`
 * (@nestjs-cls/transactional): inside a transaction that is the
 * transaction, in every service the call reaches; outside, the database.
 * A write that must be atomic is a `@Transactional()` method (or
 * `TransactionHost.withTransaction()`), and every query it causes joins.
 *
 * `@InjectDrizzle()` gives the database itself, outside any transaction:
 * only for what must outlive a rollback or never wait on one (health
 * checks, locks, sessions' last use).
 */
export type Database = NodePgDatabase;

/** The adapter's type, for `TransactionHost<DatabaseTransactions>` and `@Transactional<DatabaseTransactions>({ isolationLevel })`. */
export type DatabaseTransactions = TransactionalAdapterDrizzleOrm<Database>;
