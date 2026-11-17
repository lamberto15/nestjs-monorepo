/**
 * What went wrong with a query, for the layer that answers the caller:
 *
 * - `unique_violation`: a unique index or constraint refused the row (23505).
 * - `foreign_key_violation`: a foreign key refused the change, a row still
 *   refers to the one deleted or the one referred to is missing (23503, and
 *   23001 for an `ON DELETE RESTRICT` key).
 * - `pool_exhausted`: no free connection within DATABASE_POOL_TIMEOUT_MS.
 * - `statement_timeout`: PostgreSQL cancelled the statement after
 *   DATABASE_STATEMENT_TIMEOUT_MS (57014).
 */
export type DatabaseErrorKind =
  | 'unique_violation'
  | 'foreign_key_violation'
  | 'pool_exhausted'
  | 'statement_timeout';

const BY_SQLSTATE: Record<string, DatabaseErrorKind> = {
  '23505': 'unique_violation',
  '23503': 'foreign_key_violation',
  '23001': 'foreign_key_violation',
  '57014': 'statement_timeout',
};

/**
 * The kind of a database error, or undefined for any other error. Drizzle
 * wraps the driver's error (DrizzleQueryError, the original in `cause`), so
 * the chain is searched.
 */
export function databaseErrorKind(
  error: unknown,
): DatabaseErrorKind | undefined {
  for (let e = error, depth = 0; e && depth < 5; depth++) {
    const { message, code, cause } = e as {
      message?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string' && BY_SQLSTATE[code]) {
      return BY_SQLSTATE[code];
    }
    // node-postgres' pool says so in its message only.
    if (
      typeof message === 'string' &&
      message.includes('timeout exceeded when trying to connect')
    ) {
      return 'pool_exhausted';
    }
    e = cause;
  }
  return undefined;
}
