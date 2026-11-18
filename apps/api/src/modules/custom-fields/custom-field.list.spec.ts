import type { SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect, pgTable, uuid } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import type { RecordTable } from '../records/record.js';
import { customFilterFields } from './custom-field.list.js';
import type { CustomFieldDefinition } from './custom-field.types.js';

const invoices = pgTable('invoices', { id: uuid('id').primaryKey() });
const dialect = new PgDialect();
const render = (query: SQL) => dialect.sqlToQuery(query);

const field = (
  key: string,
  type: CustomFieldDefinition['type'],
  extra: Partial<CustomFieldDefinition> = {},
): CustomFieldDefinition => ({
  id: key,
  subject: 'Invoice',
  key,
  label: key,
  description: null,
  type,
  options: null,
  required: false,
  defaultValue: null,
  validation: null,
  position: 0,
  filterable: true,
  sortable: true,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

describe('customFilterFields', () => {
  const source = {
    db: drizzle.mock() as unknown as Database,
    subject: 'Invoice',
    table: invoices as unknown as RecordTable,
  };
  const { fields, select } = customFilterFields(
    [
      field('region', 'select', { options: [{ value: 'eu', label: 'EU' }] }),
      field('amount', 'number'),
      field('due', 'date'),
      field('done', 'boolean'),
      field('tags', 'multiSelect', { options: [{ value: 'a', label: 'A' }] }),
      field('note', 'text', { filterable: false, sortable: false }),
      field('old', 'text', { active: false }),
    ],
    source,
  );

  it('declares the active fields filterable or sortable; every active one can be selected', () => {
    expect(Object.keys(fields)).toEqual([
      'custom.region',
      'custom.amount',
      'custom.due',
      'custom.done',
      'custom.tags',
    ]);
    expect(select).toEqual([
      'custom.region',
      'custom.amount',
      'custom.due',
      'custom.done',
      'custom.tags',
      'custom.note',
    ]);
    expect(fields['custom.region']).toMatchObject({
      type: 'enum',
      values: ['eu'],
    });
    expect(fields['custom.due']!.type).toBe('date');
    expect(fields['custom.tags']!.sortable).toBe(false);
  });

  it("reads a record's value by a subquery on its values, typed", () => {
    const amount = render(fields['custom.amount']!.column as SQL);
    expect(amount.sql).toMatch(
      /^\(+select .+ ->> \$1::text from "custom_field_values" where .+"invoices"\."id"\)+::numeric$/,
    );
    expect(amount.params).toContain('amount');
    expect(amount.params).toContain('Invoice');
  });

  it('compiles eq, in and isNull to containment and the key operator, which the GIN index serves', () => {
    const eq = render(fields['custom.region']!.conditions!.eq!('eu'));
    expect(eq.sql).toContain('"invoices"."id" in (select');
    expect(eq.sql).toContain('@> $');
    expect(eq.params).toContain('{"region":"eu"}');
    expect(
      render(fields['custom.amount']!.conditions!.eq!(5)).params,
    ).toContain('{"amount":5}');
    expect(
      render(fields['custom.tags']!.conditions!.in!(['a'])).params,
    ).toContain('{"tags":["a"]}');
    expect(
      render(fields['custom.region']!.conditions!.isNull!(false)).sql,
    ).toContain('"invoices"."id" in (select');
    expect(
      render(fields['custom.region']!.conditions!.isNull!(true)).sql,
    ).toContain('"invoices"."id" not in (select');
    // ne and the ordered operators compare the typed value itself.
    expect(fields['custom.amount']!.conditions).not.toHaveProperty('gt');
    expect(fields['custom.region']!.conditions).not.toHaveProperty('ne');
  });

  it('refuses a key that is not a slug', () => {
    expect(() =>
      customFilterFields([field("x'; drop", 'text')], source),
    ).toThrow('Invalid custom field key');
  });
});
