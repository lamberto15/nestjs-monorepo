import { field, type Referenced } from '../../../src/modules/fields/field.js';
import { defineRecord } from '../../../src/modules/records/record.js';
import { recordTableOf } from '../../../src/modules/records/record-relations.js';

/**
 * Keyed records, for the tests of record keys (record-keys.ts): what
 * exports, imports and numbers name a record by. A shelf by its unique
 * code; a book by its code within its shelf (`S1/B1`); a loan by a
 * reference its naming series fills when left empty.
 */
export const KEYED_SHELF = defineRecord({
  subject: 'KeyedShelf',
  path: 'keyed-shelves',
  noun: 'keyed shelf',
  table: 'test_keyed_shelves',
  key: 'code',
  softDelete: true,
  unit: false,
  fields: {
    code: field.string().unique(),
    name: field.string().optional(),
  },
});

export const KEYED_BOOK = defineRecord({
  subject: 'KeyedBook',
  path: 'keyed-books',
  noun: 'keyed book',
  table: 'test_keyed_books',
  key: 'code',
  keyWithin: 'shelfId',
  softDelete: true,
  unit: false,
  fields: {
    shelfId: field.ref((): Referenced => recordTableOf(KEYED_SHELF)),
    code: field.string(),
    title: field.string().optional(),
  },
});

export const KEYED_LOAN = defineRecord({
  subject: 'KeyedLoan',
  path: 'keyed-loans',
  noun: 'keyed loan',
  table: 'test_keyed_loans',
  key: 'reference',
  softDelete: false,
  unit: false,
  fields: {
    reference: field.string().optional().unique(),
    bookId: field.ref((): Referenced => recordTableOf(KEYED_BOOK)),
  },
});
