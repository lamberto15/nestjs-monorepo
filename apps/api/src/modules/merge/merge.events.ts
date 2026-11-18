import { defineEvent } from '../../core/outbox/events.js';
import { type RecordDeclaration, recordKey } from '../records/record.js';

/** What a merge tells the modules that keep rows about a record (comments, tags, watchers…). */
export interface RecordMergedPayload {
  subject: string;
  /** The survivor: what the duplicate's rows move to. */
  id: string;
  duplicateId: string;
  by: string;
}

/**
 * `<item>.merged`, published in the merge's transaction and delivered after
 * it commits. An add-on that keeps rows by (subject, record id) subscribes
 * and moves the duplicate's to the survivor, with no import of this module:
 * `@OnDomainEvent(defineEvent<RecordMergedPayload>('invoice.merged'), { consumer: 'tags-merge' })`.
 */
export const mergeEvents = (record: RecordDeclaration) => ({
  merged: defineEvent<RecordMergedPayload>(`${recordKey(record)}.merged`),
});
