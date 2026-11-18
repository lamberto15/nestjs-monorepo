import { describe, expect, it } from 'vitest';
import { evaluate, OPERATORS_BY_TYPE } from './rules';

describe('form conditions (the web mirror of the API)', () => {
  it('reads a missing answer as empty, and compares only values of one type', () => {
    expect(evaluate({ field: 'a', op: 'isEmpty' }, {})).toBe(true);
    expect(evaluate({ field: 'a', op: 'ne', value: 'x' }, {})).toBe(true);
    expect(evaluate({ field: 'a', op: 'gt', value: 1 }, {})).toBe(false);
    expect(evaluate({ field: 'a', op: 'gt', value: 1 }, { a: '2' })).toBe(
      false,
    );
    expect(
      evaluate(
        { field: 'd', op: 'lt', value: '2026-02-01' },
        { d: '2026-01-31' },
      ),
    ).toBe(true);
    expect(
      evaluate({ field: 'm', op: 'contains', value: 'b' }, { m: ['a', 'b'] }),
    ).toBe(true);
    expect(OPERATORS_BY_TYPE['text']).toContain('isEmpty');
  });
});
