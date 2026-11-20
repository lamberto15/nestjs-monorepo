import { recordTable } from '../../../src/modules/records/record.js';
import { KEYED_BOOK, KEYED_LOAN, KEYED_SHELF } from './keyed.records.js';

/** The keyed records' tables: a book's code is unique within its shelf (`keyWithin`). */
export const keyedShelves = recordTable(KEYED_SHELF);
export const keyedBooks = recordTable(KEYED_BOOK);
export const keyedLoans = recordTable(KEYED_LOAN);
