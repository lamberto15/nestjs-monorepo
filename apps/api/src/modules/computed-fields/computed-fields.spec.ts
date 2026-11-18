import { field } from '../fields/field.js';
import { defineRecord } from '../records/record.js';
import {
  computed,
  computedResponse,
  defineComputed,
  hideComputed,
  withComputed,
} from './computed-fields.js';

const LINE = defineRecord({
  subject: 'Line',
  path: 'lines',
  noun: 'line',
  table: 'lines',
  softDelete: false,
  unit: false,
  fields: {
    quantity: field.int(),
    unitPrice: field.money(),
    note: field.string().optional(),
    extra: field.json().optional(),
  },
});

describe('computed fields', () => {
  it('computes on read, each after those it reads, hidden with what they read', () => {
    const LINE_COMPUTED = defineComputed(LINE, {
      // Declared before what it reads: computed in the order they need.
      withTax: computed.money('total * 1.19'),
      total: computed.money('quantity * unitPrice'),
      perUnit: computed.decimal('quantity'),
      labelled: computed.string("coalesce(note, 'none')"),
      broken: computed.decimal('quantity / 0'),
    });
    const [line] = withComputed(LINE_COMPUTED, [
      {
        quantity: 2,
        unitPrice: { amount: '10.00', currency: 'EUR' },
        note: null,
      },
    ]);
    expect(line).toMatchObject({
      total: { amount: '20.00', currency: 'EUR' },
      withTax: { amount: '23.80', currency: 'EUR' },
      perUnit: '2',
      labelled: 'none',
      // A value it can't compute is null.
      broken: null,
    });
    // A reader who may not see the price sees neither total, nor what reads it.
    const shown = hideComputed(LINE_COMPUTED, line!, ['unitPrice']);
    expect(shown).not.toHaveProperty('total');
    expect(shown).not.toHaveProperty('withTax');
    expect(shown).toMatchObject({ perUnit: '2', labelled: 'none' });
    expect(hideComputed(LINE_COMPUTED, line!, [])).toBe(line);
  });

  it('documents each one in the response, nullable and optional', () => {
    const shape = computedResponse(
      defineComputed(LINE, { total: computed.money('quantity * unitPrice') }),
    );
    expect(shape.total.safeParse(null).success).toBe(true);
    expect(shape.total.safeParse(undefined).success).toBe(true);
    expect(shape.total.description).toContain('quantity * unitPrice');
  });

  it('refuses computed fields that cycle, mistype, read what is not there or take a name', () => {
    expect(() =>
      defineComputed(LINE, {
        a: computed.int('b + 1'),
        b: computed.int('a + quantity'),
      }),
    ).toThrow(/cycle: a → b → a/);
    expect(() => defineComputed(LINE, { a: computed.int('a') })).toThrow(
      /cycle/,
    );
    expect(() =>
      defineComputed(LINE, { a: computed.string('quantity') }),
    ).toThrow(/is declared string, but `quantity` is int/);
    expect(() =>
      defineComputed(LINE, { a: computed.string('text(extra)') }),
    ).toThrow(/"extra"/);
    expect(() => defineComputed(LINE, { quantity: computed.int('1') })).toThrow(
      /takes a name the record already shows/,
    );
    expect(() => defineComputed(LINE, { tags: computed.int('1') })).toThrow(
      /takes a name the record already shows/,
    );
    expect(() =>
      defineComputed(LINE, { a: computed.int('process.exit()') }),
    ).toThrow(/computed field "a"/);
  });
});
