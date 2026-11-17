import { listQuery } from '../../core/http/list-query.js';
import { recordScheduleSchema } from './recurrence.schemas.js';
import { recordSchedules } from './recurrence.tables.js';

/** What GET /record-schedules can be filtered and sorted by (the caller's own, a handful). */
export const RECORD_SCHEDULE_LIST = listQuery(
  {
    target: {
      column: recordSchedules.target,
      type: 'string',
      ops: ['eq', 'in'],
    },
    status: {
      column: recordSchedules.status,
      type: 'string',
      ops: ['eq', 'in'],
    },
    name: {
      column: recordSchedules.name,
      type: 'string',
      ops: ['eq', 'contains'],
      sortable: true,
    },
    nextRunAt: {
      column: recordSchedules.nextRunAt,
      type: 'datetime',
      ops: ['gte', 'lt', 'between'],
      sortable: true,
    },
    createdAt: {
      column: recordSchedules.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(recordScheduleSchema.shape) },
);
