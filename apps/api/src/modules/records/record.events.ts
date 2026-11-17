import { defineEvent } from '../../core/outbox/events.js';
import { type RecordDeclaration, recordKey } from './record.js';

/**
 * What a record's domain event carries: its id, who acted
 * (`user:<id>`…), and the record as the API shows it then (no tenant, no
 * redaction: a subscriber that sends it out redacts for its receiver).
 */
export interface RecordEventPayload {
  subject: string;
  id: string;
  by: string;
  record: Record<string, unknown>;
}

/**
 * A record's domain events (core/outbox), `<item>.created`, `.updated`,
 * `.deleted`, `.restored`: published by RecordStore in the transaction of
 * the change, delivered after it commits. Subscribe with
 * `@OnDomainEvent(recordEvents(INVOICE).created, { consumer: '…' })`.
 */
export const recordEvents = (declaration: RecordDeclaration) => {
  const key = recordKey(declaration);
  return {
    created: defineEvent<RecordEventPayload>(`${key}.created`),
    updated: defineEvent<RecordEventPayload>(`${key}.updated`),
    deleted: defineEvent<RecordEventPayload>(`${key}.deleted`),
    restored: defineEvent<RecordEventPayload>(`${key}.restored`),
  };
};
