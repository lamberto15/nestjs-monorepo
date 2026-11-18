import { field } from '../fields/field.js';
import { defineRecord } from '../records/record.js';
import { bodyOf, importSchema, matchKeys } from './record-transfer.js';

const ITEM = defineRecord({
  subject: 'TransferItem',
  path: 'transfer-items',
  noun: 'transfer item',
  table: 'transfer_items',
  softDelete: false,
  unit: false,
  fields: {
    title: field.string(),
    code: field.string().optional().unique(),
    count: field.int().optional(),
    done: field.bool(),
    total: field.money().optional(),
    words: field.int().optional().readOnly(),
  },
});

describe('a file row as the create body', () => {
  it('converts the cells of typed fields, and leaves out blank, read-only and unknown ones', () => {
    expect(
      bodyOf(ITEM, {
        title: 'One',
        code: '',
        count: '12',
        done: 'TRUE',
        total: '12.50 eur',
        words: '3',
        owner: 'user:1',
      }),
    ).toEqual({
      title: 'One',
      count: 12,
      done: true,
      total: { amount: '12.50', currency: 'EUR' },
    });
  });

  it('leaves a cell that does not fit to the schema, which says why', () => {
    const body = bodyOf(ITEM, { title: 'One', count: 'many', done: 'maybe' });
    expect(body).toEqual({ title: 'One', count: 'many', done: 'maybe' });
    const parsed = importSchema(ITEM).safeParse(body);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path[0])).toEqual(
      expect.arrayContaining(['count', 'done']),
    );
  });

  it('matches on the id and the unique fields', () => {
    expect(matchKeys(ITEM)).toEqual(['id', 'code']);
  });
});
