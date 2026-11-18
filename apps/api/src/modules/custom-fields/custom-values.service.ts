import { InjectTransaction } from '@nestjs-cls/transactional';
import { BadRequestException, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type RecordDeclaration,
  recordKey,
  type RecordTable,
} from '../records/record.js';
import { customFilterFields } from './custom-field.list.js';
import type { CustomFieldDefinition } from './custom-field.types.js';
import { customValuesSchema } from './custom-field.values.js';
import { CustomFieldsService } from './custom-fields.service.js';
import { customFieldValues as v } from './custom-fields.tables.js';

type Values = Record<string, unknown>;

/**
 * The custom values records hold (custom_field_values), checked against
 * their subject's active fields on every write, in the write's
 * transaction: the record's hooks (custom-fields.extension.ts) call it.
 */
@Injectable()
export class CustomValuesService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly fields: CustomFieldsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `custom` of a write, checked against the subject's active fields: a 400
   * naming each wrong one (`custom.region`) otherwise. On create, required
   * fields need a value and defaults fill what is left out; on update, a
   * patch (`null` removes a key, not a required one's).
   */
  parse(
    fields: CustomFieldDefinition[],
    input: unknown,
    mode: 'create' | 'update',
  ): Values {
    const parsed = customValuesSchema(fields, mode).safeParse(input ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'The request is invalid.',
        errors: parsed.error.issues.map((issue) => ({
          path: ['custom', ...issue.path].join('.'),
          message: issue.message,
        })),
      });
    }
    return parsed.data;
  }

  /** The values stored for these records, by id (all keys, inactive fields' too). */
  async of(subject: string, ids: readonly string[]) {
    const found = new Map<string, Values>();
    if (ids.length === 0) return found;
    const rows = await this.db
      .select({ recordId: v.recordId, values: v.values })
      .from(v)
      .where(and(eq(v.subject, subject), inArray(v.recordId, [...ids])));
    for (const row of rows) found.set(row.recordId, row.values);
    return found;
  }

  /** A new record's values: checked, with the defaults. */
  async created(subject: string, recordId: string, input: unknown) {
    const fields = await this.fields.definitions(subject);
    const values = this.parse(fields, input, 'create');
    if (Object.keys(values).length > 0) {
      await this.db.insert(v).values({ subject, recordId, values });
    }
  }

  /**
   * A changed record's values: only the keys sent change, `null` removes
   * one, keys of inactive fields stay. Audited key by key (from → to).
   */
  async updated(
    by: Principal,
    record: RecordDeclaration,
    recordId: string,
    input: unknown,
  ) {
    if (input === undefined) return;
    const { subject } = record;
    const fields = await this.fields.definitions(subject);
    const patch = this.parse(fields, input, 'update');
    const before = (await this.of(subject, [recordId])).get(recordId) ?? {};
    const after: Values = { ...before };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete after[key];
      else after[key] = value;
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changes[key] = { from: before[key] ?? null, to: after[key] ?? null };
      }
    }
    if (Object.keys(changes).length === 0) return;
    if (Object.keys(after).length === 0) {
      await this.forget(subject, [recordId]);
    } else {
      await this.db
        .insert(v)
        .values({ subject, recordId, values: after })
        .onConflictDoUpdate({
          target: [v.tenantId, v.subject, v.recordId],
          set: { values: after, updatedAt: new Date() },
        });
    }
    await this.audit.record(by, {
      action: `${recordKey(record)}.customValuesUpdated`,
      targetType: recordKey(record),
      targetId: recordId,
      details: { changes },
    });
  }

  /** Records gone for good: their values go too. */
  async forget(subject: string, ids: readonly string[]) {
    if (ids.length === 0) return;
    await this.db
      .delete(v)
      .where(and(eq(v.subject, subject), inArray(v.recordId, [...ids])));
  }

  /** Records as shown, each with `custom`: the values of active fields (a page at once). */
  async present(subject: string, views: Record<string, unknown>[]) {
    const [fields, stored] = await Promise.all([
      this.fields.definitions(subject),
      this.of(
        subject,
        views.map((view) => view.id as string),
      ),
    ]);
    const active = new Set(fields.map((field) => field.key));
    return views.map((view) => ({
      ...view,
      custom: Object.fromEntries(
        Object.entries(stored.get(view.id as string) ?? {}).filter(([key]) =>
          active.has(key),
        ),
      ),
    }));
  }

  /** The subject's active fields as list fields (`custom.<key>`), for its table. */
  async listFields(subject: string, table: RecordTable) {
    return customFilterFields(await this.fields.definitions(subject), {
      db: this.db,
      subject,
      table,
    });
  }
}
