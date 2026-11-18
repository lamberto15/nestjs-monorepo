import { defineEvent } from '../../core/outbox/events.js';
import { type RecordDeclaration, recordKey } from '../records/record.js';

/** A rule's run on one record's change, published in the transaction of the change. */
export interface AutomationDue {
  ruleId: string;
  /** The rule's version when the change happened: a newer one runs nothing. */
  version: number;
  recordId: string;
}

/**
 * Published by a record's write (the rule's trigger held): the run happens
 * in the worker, after the commit, if and only if the write commits.
 */
export const automationDue = defineEvent<AutomationDue>('automation.due');

/**
 * The webhook a rule's `webhook` action sends about a record of this kind
 * (`testItem.automation-matched`): the record, as each API client may read
 * it, with the rule that matched.
 */
export const automationMatched = (record: RecordDeclaration) =>
  defineEvent<Record<string, unknown>>(
    `${recordKey(record)}.automation-matched`,
  );
