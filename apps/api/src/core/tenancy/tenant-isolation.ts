import type { AnyPgColumn, PgPolicy } from 'drizzle-orm/pg-core';
import type { ClientBase, Pool, PoolConfig } from 'pg';
import type { Database } from '../database/database.js';
import { rowLevelSecurity } from './row-level-security.js';

/**
 * Everything that depends on how tenants are kept apart, behind one seam
 * (the owner's decision: modules never know the isolation mode). It has one
 * implementation, row-level security (row-level-security.ts); an interface
 * with a single implementation is otherwise against the rules, and is here
 * so that schema-per-tenant or database-per-tenant can replace it without
 * a module changing (README.md, "Other isolation modes").
 */
export interface TenantIsolation {
  /** What a tenant table declares besides its columns, so `pnpm db:generate` emits it (tenantTable()). */
  tableWall(table: string, tenantId: AnyPgColumn): PgPolicy[];

  /**
   * The pool every query of the app goes through: each query and each
   * transaction bound to the tenant scope of its async context, and the
   * cross-tenant scope sent to the maintenance role's connections
   * (`acrossTenants`; refused without them). Checks the runtime role first.
   */
  connect(settings: {
    app: PoolConfig;
    acrossTenants?: PoolConfig;
  }): Promise<Pool>;

  /**
   * After the migrations, as the tables' owner, in the migration's
   * transaction: puts the wall in place where the migrations can't, and
   * refuses (throws) when any tenant table lacks it.
   */
  secure(owner: ClientBase, log: (line: string) => void): Promise<void>;

  /** A new tenant's own storage, in the transaction that adds its row. */
  provision(db: Database, tenantId: string): Promise<void>;
}

/** The isolation this app uses. */
export const isolation: TenantIsolation = rowLevelSecurity;
