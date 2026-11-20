import { field } from '../fields/field.js';
import { defineRecord } from '../records/record.js';
import { assertNumberedField } from './sequences.record.js';

const RECORD = defineRecord({
  subject: 'NumberedFieldCheck',
  path: 'numbered-field-checks',
  noun: 'numbered field check',
  table: 'numbered_field_checks',
  softDelete: false,
  unit: false,
  fields: {
    reference: field.string().optional().unique(),
    required: field.string().unique(),
    plain: field.string().optional(),
    count: field.int().optional(),
  },
});

describe('assertNumberedField', () => {
  it('takes an optional, unique string field', () => {
    expect(() => assertNumberedField(RECORD, 'reference')).not.toThrow();
  });

  it.each(['missing', 'required', 'plain', 'count'])(
    'refuses "%s": no field, a required one, a non-unique one, or not text',
    (name) => {
      expect(() => assertNumberedField(RECORD, name)).toThrow(
        /must be an optional, unique, writable string field/,
      );
    },
  );
});
