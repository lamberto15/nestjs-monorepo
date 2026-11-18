import { ForbiddenException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Events } from '../../core/outbox/events.js';
import { AccessService } from '../../iam/access/access.service.js';
import { principalKey } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import type { AnyField, FieldKind } from '../fields/field.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { recordValues, recordView } from '../records/record.js';
import { relationTitle } from '../records/record-relations.js';
import type { RecordRegistration } from '../records/records.service.js';
import {
  type ActionContext,
  AutomationAction,
  type AutomationActionHandler,
  type PlannedAction,
} from './automation-actions.js';
import { automationMatched } from './automations.events.js';

/** At most this many people one `notify` action tells. */
export const MAX_NOTIFIED = 10;

/** The kinds a rule may set: plain values, never a reference, money or JSON. */
const SETTABLE: readonly FieldKind[] = [
  'string',
  'text',
  'int',
  'decimal',
  'bool',
  'enum',
  'date',
  'datetime',
];

/** A record's field a rule may set, with the schema of its value; undefined when it may not. */
function settable(record: RecordRegistration, name: string) {
  const field = record.declaration.fields[name] as AnyField | undefined;
  if (!field || field.options.readOnly || !SETTABLE.includes(field.kind)) {
    return undefined;
  }
  return field.options.optional ? field.input.nullable() : field.input;
}

/** What a record is called by: its first string field, else its id. */
export function titleOf(
  record: RecordRegistration,
  view: Record<string, unknown>,
) {
  const name = relationTitle(record.declaration);
  const value = name ? view[name] : undefined;
  return typeof value === 'string' && value ? value : null;
}

const setFieldParams = z.object({
  field: z.string().min(1).max(100),
  value: z
    .union([z.string().max(10_000), z.number(), z.boolean(), z.null()])
    .describe("The field's new value, as its PATCH route takes it."),
});
type SetFieldParams = z.infer<typeof setFieldParams>;

/**
 * `{ field, value }`: changes the record through its store, as the rule's
 * owner (who needs `update` on it and on the field), audited as theirs.
 */
@AutomationAction('setField')
@Injectable()
export class SetFieldAction implements AutomationActionHandler<SetFieldParams> {
  readonly params = setFieldParams;

  constructor(private readonly access: AccessService) {}

  describe(record: RecordRegistration) {
    return {
      fields: Object.keys(record.declaration.fields).filter((name) =>
        settable(record, name),
      ),
    };
  }

  check(record: RecordRegistration, { field, value }: SetFieldParams) {
    const schema = settable(record, field);
    if (!schema) {
      return [
        {
          path: 'field',
          message: `${record.declaration.subject}.${field} cannot be set by a rule.`,
        },
      ];
    }
    return schema.safeParse(value).success
      ? []
      : [{ path: 'value', message: `Not a value of ${field}.` }];
  }

  async plan({
    record,
    principal,
    row,
    params: { field, value },
  }: ActionContext<SetFieldParams>): Promise<PlannedAction> {
    const { subject } = record.declaration;
    const detail = `${field} = ${JSON.stringify(value)}`;
    if (!(await this.access.can(principal, 'update', subject, row))) {
      return { allowed: false, reason: 'forbidden', detail };
    }
    const schema = settable(record, field);
    const forbidden = await this.access.forbiddenFields(
      principal,
      'update',
      subject,
      { [field]: value },
      row,
    );
    if (!schema || forbidden.length) {
      return { allowed: false, reason: 'field_forbidden', detail };
    }
    const dto = { [field]: schema.parse(value) as unknown };
    return {
      allowed: true,
      detail,
      apply: async () => {
        await record.store.update(
          principal,
          row.id,
          recordValues(record.declaration, dto),
          {
            input: dto,
            // On the locked row: the owner may still change it.
            check: async (current) => {
              if (
                !(await this.access.can(principal, 'update', subject, current))
              ) {
                throw new ForbiddenException({
                  code: 'forbidden',
                  message: 'setField: forbidden',
                });
              }
            },
          },
        );
      },
    };
  }
}

const notifyParams = z.object({
  userIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_NOTIFIED)
    .describe(
      'Members told (by their preferences); only those who may read the record.',
    ),
});
type NotifyParams = z.infer<typeof notifyParams>;

/** `{ userIds }`: the `automation.notified` notification, to those of them who may read the record. */
@AutomationAction('notify')
@Injectable()
export class NotifyAction implements AutomationActionHandler<NotifyParams> {
  readonly params = notifyParams;

  constructor(
    private readonly access: AccessService,
    private readonly users: UsersRepository,
    private readonly notifications: NotificationsService,
  ) {}

  async plan({
    record,
    principal,
    row,
    params,
    rule,
  }: ActionContext<NotifyParams>): Promise<PlannedAction> {
    const { subject, path } = record.declaration;
    const recipients: string[] = [];
    for (const id of params.userIds) {
      const user = await this.users.inTenant(id, principal.tenantId);
      if (user && (await this.access.can(user, 'read', subject, row))) {
        recipients.push(principalKey(user));
      }
    }
    const detail = `${recipients.length} of ${params.userIds.length}`;
    if (!recipients.length) {
      return { allowed: false, reason: 'no_recipient', detail };
    }
    return {
      allowed: true,
      detail,
      apply: async () => {
        await this.notifications.notify({
          type: 'automation.notified',
          to: recipients,
          data: {
            rule: rule.name,
            subject,
            recordId: row.id,
            title:
              titleOf(record, recordView(record.declaration, row)) ?? row.id,
          },
          link: `/${path}/${row.id}`,
        });
      },
    };
  }
}

/**
 * `{}`: the `<item>.automation-matched` webhook (AutomationsModule.forRecord()
 * declares it), to the API clients subscribed to it that may read the
 * record, as they may read it (WebhooksModule's publisher decides).
 */
@AutomationAction('webhook')
@Injectable()
export class WebhookAction implements AutomationActionHandler {
  readonly params = z.object({});

  constructor(private readonly events: Events) {}

  describe(record: RecordRegistration) {
    return { event: automationMatched(record.declaration).type };
  }

  plan({ record, row, rule }: ActionContext<object>): Promise<PlannedAction> {
    const event = automationMatched(record.declaration);
    return Promise.resolve({
      allowed: true,
      detail: event.type,
      apply: () =>
        this.events.publish(
          event,
          {
            ...recordView(record.declaration, row),
            automationRule: { id: rule.id, name: rule.name },
          },
          { key: row.id },
        ),
    });
  }
}
