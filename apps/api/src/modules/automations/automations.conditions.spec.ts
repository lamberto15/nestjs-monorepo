import { ExpressionError } from '../expressions/expression.js';
import { field } from '../fields/field.js';
import { defineRecord } from '../records/record.js';
import {
  compileCondition,
  conditionVariables,
} from './automations.conditions.js';

const INVOICE = defineRecord({
  subject: 'Invoice',
  path: 'invoices',
  noun: 'invoice',
  table: 'invoices',
  softDelete: false,
  unit: true,
  fields: {
    title: field.string(),
    total: field.money(),
    paid: field.bool().default(false),
    dueOn: field.date().optional(),
    extra: field.json().optional(),
  },
});

describe('automation conditions', () => {
  it('reads the fields as the API shows them, and the columns every record has', () => {
    expect(conditionVariables(INVOICE)).toEqual({
      id: 'string',
      ownerId: 'string',
      unitId: 'string',
      createdAt: 'datetime',
      updatedAt: 'datetime',
      title: 'string',
      total: 'money',
      paid: 'bool',
      dueOn: 'date',
    });
  });

  it('compiles a yes/no question and evaluates it on a record', () => {
    const condition = compileCondition(INVOICE, "not paid and title == 'Rent'");
    expect(condition.reads).toEqual(['paid', 'title']);
    expect(condition.evaluate({ paid: false, title: 'Rent' })).toBe(true);
    expect(condition.evaluate({ paid: true, title: 'Rent' })).toBe(false);
  });

  it('refuses a condition that is not one, or reads what it may not', () => {
    expect(() => compileCondition(INVOICE, 'title')).toThrow(TypeError);
    expect(() => compileCondition(INVOICE, 'extra == 1')).toThrow(
      ExpressionError,
    );
    expect(() => compileCondition(INVOICE, 'paid ==')).toThrow(ExpressionError);
  });
});
