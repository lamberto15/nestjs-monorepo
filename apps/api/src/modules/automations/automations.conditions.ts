import {
  compileExpression,
  type Expression,
  type ExpressionType,
} from '../expressions/expression.js';
import type { AnyField, FieldKind } from '../fields/field.js';
import type { RecordDeclaration } from '../records/record.js';

/** What a condition reads a field's value as; a JSON field it can't read. */
const TYPES: Partial<Record<FieldKind, ExpressionType>> = {
  string: 'string',
  text: 'string',
  enum: 'string',
  ref: 'string',
  int: 'int',
  decimal: 'decimal',
  money: 'money',
  bool: 'bool',
  date: 'date',
  datetime: 'datetime',
};

/**
 * The names a rule's condition may read on a record, with their types:
 * its fields (as the API shows them) and the columns every record has.
 */
export function conditionVariables(
  record: RecordDeclaration,
): Record<string, ExpressionType> {
  const variables: Record<string, ExpressionType> = {
    id: 'string',
    ownerId: 'string',
    ...(record.unit && { unitId: 'string' as const }),
    createdAt: 'datetime',
    updatedAt: 'datetime',
  };
  for (const [name, field] of Object.entries(record.fields)) {
    const type = TYPES[(field as AnyField).kind];
    if (type) variables[name] = type;
  }
  return variables;
}

/**
 * A rule's condition compiled against the record's names: it must be a
 * yes/no question. Throws an ExpressionError (syntax, an unknown name, a
 * type) or a TypeError for one that answers something else.
 */
export function compileCondition(
  record: RecordDeclaration,
  source: string,
): Expression {
  const expression = compileExpression(source, conditionVariables(record));
  if (expression.type !== 'bool') {
    throw new TypeError(
      `A condition answers true or false; this one gives a ${expression.type}.`,
    );
  }
  return expression;
}
