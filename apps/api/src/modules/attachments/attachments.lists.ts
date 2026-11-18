import { listQuery } from '../../core/http/list-query.js';
import { attachmentSchema } from './attachments.schemas.js';
import { attachments } from './attachments.tables.js';

/** What a record's attachment list can be filtered and sorted by (newest first). */
export const ATTACHMENT_LIST = listQuery(
  {
    contentType: {
      column: attachments.contentType,
      type: 'string',
      ops: ['eq', 'in'],
    },
    name: {
      column: attachments.name,
      type: 'string',
      ops: ['eq', 'contains'],
      sortable: true,
    },
    size: {
      column: attachments.size,
      type: 'number',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
    scanStatus: {
      column: attachments.scanStatus,
      type: 'enum',
      values: ['pending', 'clean'],
      ops: ['eq'],
    },
    uploadedBy: {
      column: attachments.uploadedBy,
      type: 'string',
      ops: ['eq', 'in'],
      ref: 'principal',
    },
    createdAt: {
      column: attachments.createdAt,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  { select: Object.keys(attachmentSchema.shape) },
);
