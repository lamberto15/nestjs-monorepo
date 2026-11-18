import { field } from '../fields/field.js';
import { defineRecord } from '../records/record.js';
import { DataQualityRegistration } from './data-quality.registry.js';

const ITEM = defineRecord({
  subject: 'QualityThing',
  path: 'quality-things',
  noun: 'thing',
  table: 'quality_things',
  softDelete: false,
  unit: false,
  fields: {
    name: field.string(),
    note: field.text().optional(),
    total: field.money(),
    count: field.int().optional(),
  },
});

describe('DataQualityRegistration', () => {
  it('compiles a rule against the record fields', () => {
    const registration = new DataQualityRegistration(ITEM, {
      recommended: ['note'],
      duplicates: ['name'],
      rules: [{ name: 'some-count', expect: 'count > 0' }],
    });
    expect(registration.rules[0]!.compiled.reads).toEqual(['count']);
  });

  it.each([
    ['an unknown recommended field', { recommended: ['nope'] }],
    ['a money field to check for empty', { recommended: ['total'] }],
    ['a duplicate on a number', { duplicates: ['count'] }],
    [
      'a rule that does not compile',
      { rules: [{ name: 'a', expect: 'nope > 1' }] },
    ],
    ['a rule that is no bool', { rules: [{ name: 'a', expect: 'count + 1' }] }],
    ['a bad rule name', { rules: [{ name: 'Not Ok', expect: 'count > 1' }] }],
    [
      'a rule name twice',
      {
        rules: [
          { name: 'a', expect: 'count > 1' },
          { name: 'a', expect: 'count > 2' },
        ],
      },
    ],
  ])('refuses %s', (_label, checks) => {
    expect(() => new DataQualityRegistration(ITEM, checks)).toThrow();
  });
});
