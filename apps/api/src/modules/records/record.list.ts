import { inArray, sql } from 'drizzle-orm';
import { listQuery } from '../../core/http/list-query.js';
import { auditRunTargets } from '../../iam/audit/audit-run.js';
import { fieldList } from '../fields/fields.list.js';
import { searchFilters } from './full-text.js';
import {
  type RecordDeclaration,
  type RecordTable,
  searchedFields,
} from './record.js';

/**
 * What GET /<path> can be filtered, sorted and narrowed (`fields=`) by,
 * from the declaration: the fields as their types allow, the owner, the
 * unit, the dates, `?q=` and `?sort=-rank` with searchable fields,
 * `?deleted=true` with a recycle bin, `?bulkRun=<id>` (what a bulk run changed). What a record's add-ons add (`?tag=`)
 * joins at runtime (RecordPresenter.query()).
 *
 * ```ts
 * export const INVOICE_LIST = recordList(INVOICE, invoices);
 * ```
 */
export function recordList(declaration: RecordDeclaration, table: object) {
  const t = table as RecordTable;
  const range = ['gt', 'gte', 'lt', 'lte', 'between'] as const;
  const searched = searchedFields(declaration);
  return listQuery(
    {
      ...(searched.length > 0 && searchFilters(t.search!, searched)),
      ...fieldList(declaration.fields, t),
      ownerId: {
        column: t.ownerId,
        type: 'string',
        ops: ['eq'],
        ref: 'principal',
      },
      ...(declaration.unit && {
        unitId: {
          column: t.unitId!,
          type: 'uuid',
          ops: ['eq', 'in', 'isNull'],
          ref: 'unit',
        },
      }),
      createdAt: {
        column: t.createdAt!,
        type: 'datetime',
        ops: [...range],
        sortable: true,
      },
      updatedAt: {
        column: t.updatedAt!,
        type: 'datetime',
        ops: [...range],
        sortable: true,
      },
      // The records a bulk run changed: the list its notification opens.
      bulkRun: {
        column: t.id,
        type: 'uuid',
        ops: ['eq'],
        conditions: {
          eq: (value) =>
            inArray(sql`${t.id}::text`, auditRunTargets(value as string)),
        },
      },
    },
    {
      select: [
        'id',
        'ownerId',
        ...(declaration.unit ? ['unitId'] : []),
        ...Object.keys(declaration.fields),
        'createdAt',
        'updatedAt',
        ...(declaration.softDelete ? ['deletedAt', 'deletedBy'] : []),
      ],
      softDelete: declaration.softDelete,
    },
  );
}
