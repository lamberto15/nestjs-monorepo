import { z } from 'zod';
import { readEnv } from './env.js';

const schema = z.object({
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
});

describe('readEnv', () => {
  it('returns the checked values, converted, with defaults', () => {
    expect(
      readEnv(schema, { DATABASE_URL: 'postgres://localhost/app', HOME: '/' }),
    ).toEqual({
      DATABASE_URL: 'postgres://localhost/app',
      DATABASE_POOL_MAX: 10,
    });
  });

  it('names every variable at fault, and no value', () => {
    const read = () =>
      readEnv(schema, { DATABASE_URL: 'secret', DATABASE_POOL_MAX: '0' });
    expect(read).toThrow(/DATABASE_URL: .+\nDATABASE_POOL_MAX: /);
    expect(read).not.toThrow(/secret/);
  });
});
