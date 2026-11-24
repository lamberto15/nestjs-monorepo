import { databaseErrorKind } from './database-errors.js';

const pgError = (code: string) => Object.assign(new Error('pg'), { code });
const wrapped = (cause: unknown) =>
  new Error('Failed query: insert …', { cause });

describe('databaseErrorKind', () => {
  it.each([
    ['23505', 'unique_violation'],
    ['23503', 'foreign_key_violation'],
    ['23001', 'foreign_key_violation'],
    ['57014', 'statement_timeout'],
    ['22P02', 'invalid_text'],
  ])("reads SQLSTATE %s as %s, also inside Drizzle's wrapper", (code, kind) => {
    expect(databaseErrorKind(pgError(code))).toBe(kind);
    expect(databaseErrorKind(wrapped(pgError(code)))).toBe(kind);
  });

  it('recognizes an exhausted pool by its message', () => {
    const error = new Error('timeout exceeded when trying to connect');
    expect(databaseErrorKind(wrapped(error))).toBe('pool_exhausted');
  });

  it('is undefined for any other error', () => {
    expect(databaseErrorKind(pgError('42P01'))).toBeUndefined();
    expect(databaseErrorKind(new Error('boom'))).toBeUndefined();
    expect(databaseErrorKind(undefined)).toBeUndefined();
    expect(databaseErrorKind('text')).toBeUndefined();
  });
});
