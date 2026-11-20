import { field } from '../fields/field.js';
import { defineRecord } from '../records/record.js';
import { REFERENCED_ITEM } from '../../../test/fixtures/sequences/referenced-item.record.js';
import '../../../test/fixtures/sequences/referenced-items.tables.js';
import {
  assertNumberedField,
  MAX_REFERENCE_DEPTH,
  numberedSubject,
} from './sequences.record.js';

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

describe('numberedSubject', () => {
  const fields = numberedSubject(REFERENCED_ITEM, {}, 'reference').fields!;

  it("reads the referenced records' fields, up a chain, at most MAX_REFERENCE_DEPTH levels", () => {
    // A referenced item → its test item → that one's parent → …
    expect(fields).toMatchObject({
      region: 'text',
      item_code: 'text',
      item_parent_code: 'text',
      item_parent_linked_publishedAt: 'datetime',
    });
    const deepest = `item${'_parent'.repeat(MAX_REFERENCE_DEPTH - 1)}_code`;
    expect(fields).toHaveProperty(deepest);
    expect(fields).not.toHaveProperty(deepest.replace('_code', '_parent_code'));
  });

  it('leaves out the numbered field and the references themselves', () => {
    expect(fields).not.toHaveProperty('reference');
    expect(fields).not.toHaveProperty('itemId');
    expect(fields).not.toHaveProperty('item_parentId');
  });
});
