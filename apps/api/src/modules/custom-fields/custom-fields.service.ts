import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import { AuthorizationService } from '@nestjs/authorization';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal, RequestPrincipal } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import {
  type CustomFieldDefinition,
  type CustomFieldType,
  hasOptions,
} from './custom-field.types.js';
import { definitionIssues } from './custom-field.values.js';
import { CustomFieldPolicy } from './custom-fields.policy.js';
import { CustomFieldsRepository } from './custom-fields.repository.js';
import type {
  CreateCustomFieldDto,
  CustomFieldListQuery,
  UpdateCustomFieldDto,
} from './custom-fields.schemas.js';

/** A definition as the API shows it (`default`, not the column's name). */
export const customFieldView = ({
  defaultValue,
  ...field
}: CustomFieldDefinition) => ({
  ...field,
  default: defaultValue ?? null,
});

/** `Invoice`'s names from its noun, as the search names subjects. */
const labelOf = (noun: string) => {
  const singular = noun[0]!.toUpperCase() + noun.slice(1);
  return { singular, plural: `${singular}s` };
};

/** Active fields a subject may have: each is a key in its records' values and a list field. */
export const MAX_ACTIVE_FIELDS = 100;

/** Type changes that keep every stored value valid: allowed even when values exist. */
const SAFE_TYPE_CHANGES: Partial<Record<CustomFieldType, CustomFieldType[]>> = {
  text: ['longText'],
  email: ['text', 'longText'],
  url: ['text', 'longText'],
};

/** The capability custom fields' extension names in GET /v1/lists/{subject}: how the subjects are found. */
export const CUSTOM_CAPABILITY = 'custom';

/**
 * Custom field definitions: what a tenant's administrators add to the
 * records that import `CustomFieldsModule.forRecord()`. Each tenant defines
 * its own (row-level security). Read from the database on each use: one
 * indexed query, so a change applies on the next request on every
 * instance with nothing to invalidate.
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly repository: CustomFieldsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly records: Records,
    private readonly audit: AuditService,
    private readonly authorization: AuthorizationService,
  ) {}

  /** The subjects the caller may read the fields of, named; a 403 when none. */
  async readableSubjects(user: RequestPrincipal) {
    const subjects = this.subjects();
    const allowed = await Promise.all(
      subjects.map(({ subject }) =>
        this.authorization.can(CustomFieldPolicy, 'read', user, subject),
      ),
    );
    const readable = subjects.filter((_, index) => allowed[index]);
    if (readable.length === 0) throw new ForbiddenException();
    return {
      items: readable.map(({ subject, noun }) => ({
        subject,
        label: labelOf(noun),
      })),
    };
  }

  /**
   * A subject's fields as the API shows them, for whoever may read the
   * subject; with how many records hold each (`include=counts`) only for
   * those who manage the fields: counting reads every value of the subject.
   */
  async list(user: RequestPrincipal, query: CustomFieldListQuery) {
    this.assertSubject(query.subject);
    await this.authorization.authorize(
      CustomFieldPolicy,
      'read',
      user,
      query.subject,
    );
    if (query.include === 'counts') {
      await this.authorization.authorize(
        CustomFieldPolicy,
        'manageCustomFields',
        user,
      );
    }
    const items = await this.definitions(query.subject, {
      includeInactive: query.includeInactive,
    });
    const counts =
      query.include === 'counts'
        ? await this.valueCounts(query.subject, items)
        : undefined;
    return {
      items: items.map((field) => ({
        ...customFieldView(field),
        ...(counts && {
          valueCount: counts.get(field.key)?.records ?? 0,
          deletedValueCount: counts.get(field.key)?.deleted ?? 0,
        }),
      })),
    };
  }

  /** The records that take custom fields: those importing CustomFieldsModule.forRecord(). */
  subjects() {
    return this.records
      .all()
      .filter((record) =>
        record.extensions.some(
          (hooks) => hooks.capability === CUSTOM_CAPABILITY,
        ),
      )
      .map((record) => record.declaration);
  }

  /** A subject that takes custom fields, or a 404. */
  assertSubject(subject: string) {
    const found = this.subjects().find((record) => record.subject === subject);
    if (!found) {
      throw new NotFoundException(`${subject} has no custom fields.`);
    }
    return found;
  }

  /** A subject's fields in their order; inactive ones too when asked. */
  async definitions(
    subject: string,
    { includeInactive = false } = {},
  ): Promise<CustomFieldDefinition[]> {
    return this.repository.definitions(subject, includeInactive);
  }

  /** One definition, or a 404. */
  async findOne(id: string): Promise<CustomFieldDefinition> {
    const field = await this.repository.findById(id);
    if (!field) throw new NotFoundException(`Custom field ${id} not found.`);
    return field;
  }

  /**
   * How many records hold a value, by field key, those in the recycle bin
   * apart (`deleted`): one query over the subject's values whatever the
   * number of fields, behind row-level security. It reads all of them:
   * asked for (`?include=counts`), not on every list.
   */
  async valueCounts(subject: string, fields: CustomFieldDefinition[]) {
    if (fields.length === 0)
      return new Map<string, { records: number; deleted: number }>();
    const row = await this.repository.valueCounts(
      subject,
      this.records.of(subject).feature.table,
      fields.map((field) => field.key),
    );
    return new Map(
      fields.map((field, index) => [
        field.key,
        { records: row?.[`r${index}`] ?? 0, deleted: row?.[`d${index}`] ?? 0 },
      ]),
    );
  }

  async create(actor: Principal, input: CreateCustomFieldDto, ip?: string) {
    this.assertSubject(input.subject);
    const definition = {
      type: input.type,
      options: input.options ?? null,
      validation: input.validation ?? null,
      defaultValue: input.default ?? null,
    };
    assertValid(definition);
    return this.txHost.withTransaction(async () => {
      await this.assertRoom(input.subject);
      const last = await this.repository.lastPosition(input.subject);
      const created = await this.repository
        .insert({
          subject: input.subject,
          key: input.key,
          label: input.label,
          description: input.description ?? null,
          ...definition,
          required: input.required ?? false,
          position: input.position ?? (last ?? -1) + 1,
          filterable: input.filterable ?? false,
          sortable: input.sortable ?? false,
        })
        // The unique index decides, so two creates of one key can't both pass.
        .catch((error: unknown) => {
          throw databaseErrorKind(error) === 'unique_violation'
            ? new ConflictException({
                code: 'custom_field_exists',
                message: `${input.subject} already has a field "${input.key}" (keys are never reused, even after a field is deactivated).`,
              })
            : error;
        });
      await this.audit.record(actor, {
        action: 'customField.created',
        targetType: 'customField',
        targetId: created.id,
        details: {
          subject: created.subject,
          key: created.key,
          type: created.type,
        },
        ip,
      });
      return created;
    });
  }

  /**
   * Changes a field; its key and subject never change. A type change is
   * refused (409) while any record holds a value, unless every value stays
   * valid (text → longText, email/url → text or longText); so is removing a
   * choice records hold. Values already stored aren't checked again against
   * new limits: they are on their record's next write.
   */
  async update(
    actor: Principal,
    id: string,
    input: UpdateCustomFieldDto,
    ip?: string,
  ) {
    return this.txHost.withTransaction(async () => {
      const before = await this.findOne(id);
      const next = {
        type: input.type ?? before.type,
        options: input.options !== undefined ? input.options : before.options,
        validation:
          input.validation !== undefined ? input.validation : before.validation,
        defaultValue:
          input.default !== undefined ? input.default : before.defaultValue,
      };
      if (
        input.type &&
        input.type !== before.type &&
        !SAFE_TYPE_CHANGES[before.type]?.includes(input.type)
      ) {
        // The options of the old type mean nothing to the new one.
        if (input.options === undefined && !hasOptions(input.type)) {
          next.options = null;
        }
        if (await this.repository.holdsValues(before.subject, before.key)) {
          throw new ConflictException({
            code: 'custom_field_in_use',
            message: `Records hold values of "${before.key}": its type can't change from ${before.type} to ${input.type}. Add a new field instead.`,
          });
        }
      }
      if (input.options !== undefined && hasOptions(before.type)) {
        const kept = new Set((input.options ?? []).map((o) => o.value));
        const removed = (before.options ?? [])
          .map((option) => option.value)
          .filter((value) => !kept.has(value));
        for (const value of removed) {
          const held = before.type === 'multiSelect' ? [value] : value;
          if (
            await this.repository.holdsValues(before.subject, before.key, held)
          ) {
            throw new ConflictException({
              code: 'custom_field_in_use',
              message: `Records hold the choice "${value}" of "${before.key}": it can't be removed.`,
            });
          }
        }
      }
      assertValid(next);
      if (input.active && !before.active) {
        await this.assertRoom(before.subject);
      }
      const after = await this.repository.update(id, {
        ...(input.label !== undefined && { label: input.label }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.required !== undefined && { required: input.required }),
        ...(input.filterable !== undefined && {
          filterable: input.filterable,
        }),
        ...(input.sortable !== undefined && { sortable: input.sortable }),
        ...(input.active !== undefined && { active: input.active }),
        ...next,
        updatedAt: new Date(),
      });
      await this.audit.record(actor, {
        action: 'customField.updated',
        targetType: 'customField',
        targetId: id,
        details: { changes: changesOf(before, after) },
        ip,
      });
      return after;
    });
  }

  /** Deactivates a field: no longer accepted or shown; the values records hold stay. */
  deactivate(actor: Principal, id: string, ip?: string) {
    return this.update(actor, id, { active: false }, ip);
  }

  /** Puts these fields of `subject` first, in this order; the others follow in theirs. */
  async reorder(actor: Principal, subject: string, ids: string[], ip?: string) {
    this.assertSubject(subject);
    if (new Set(ids).size !== ids.length) {
      throw invalid('ids', 'A field is listed twice.');
    }
    return this.txHost.withTransaction(async () => {
      const current = await this.definitions(subject, {
        includeInactive: true,
      });
      const known = new Set(current.map((field) => field.id));
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length) {
        throw invalid(
          'ids',
          `Not fields of ${subject}: ${unknown.join(', ')}.`,
        );
      }
      const order = [
        ...ids,
        ...current.map((field) => field.id).filter((id) => !ids.includes(id)),
      ];
      for (const [position, id] of order.entries()) {
        await this.repository.setPosition(id, position);
      }
      await this.audit.record(actor, {
        action: 'customField.reordered',
        targetType: 'customField',
        details: {
          subject,
          from: current.map((field) => field.key),
          to: order.map((id) => current.find((f) => f.id === id)!.key),
        },
        ip,
      });
      return this.definitions(subject, { includeInactive: true });
    });
  }

  private async assertRoom(subject: string) {
    const active = await this.repository.countActive(subject);
    if (active >= MAX_ACTIVE_FIELDS) {
      throw new ConflictException({
        code: 'custom_field_limit',
        message: `${subject} has ${MAX_ACTIVE_FIELDS} active fields, the most it may have: deactivate one first.`,
      });
    }
  }
}

const invalid = (path: string, message: string) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors: [{ path, message }],
  });

function assertValid(definition: Parameters<typeof definitionIssues>[0]) {
  const issues = definitionIssues(definition);
  if (issues.length) {
    throw new BadRequestException({
      code: 'validation_failed',
      message: 'The field definition is invalid.',
      errors: issues,
    });
  }
}

/** What an update changed, field by field (from → to), for the audit log. */
function changesOf(
  before: CustomFieldDefinition,
  after: CustomFieldDefinition,
) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after) as (keyof CustomFieldDefinition)[]) {
    if (key === 'updatedAt' || key === 'createdAt') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes[key] = { from: before[key], to: after[key] };
    }
  }
  return changes;
}
