import { sql } from 'drizzle-orm';
import { listQuery } from '../../core/http/list-query.js';
import { tagSchema } from './tags.schemas.js';
import { tags } from './tags.tables.js';

/** What GET /tags can be filtered and sorted by. */
export const TAG_LIST = listQuery(
  {
    subject: { column: tags.subject, type: 'string', ops: ['eq', 'in'] },
    name: {
      column: tags.name,
      type: 'string',
      ops: ['eq', 'contains', 'startsWith'],
      // A name is unique whatever its case: so are its filter and its order.
      sortable: true,
      sort: sql`lower(${tags.name})`,
      conditions: {
        eq: (value) => sql`lower(${tags.name}) = lower(${value as string})`,
      },
    },
    createdAt: {
      column: tags.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    updatedAt: {
      column: tags.updatedAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(tagSchema.shape) },
);
