import { Injectable } from '@nestjs/common';
import type { Principal } from '../../iam/auth/principal.js';
import type { RecordDeclaration, RecordRow } from '../records/record.js';
import {
  InjectRecord,
  type RecordChange,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import { Records } from '../records/records.service.js';
import {
  CUSTOM_CAPABILITY,
  CustomFieldsService,
} from './custom-fields.service.js';
import { CustomValuesService } from './custom-values.service.js';

/**
 * What custom fields add to a record: `custom` on its create and update
 * bodies (checked against the tenant's active fields, in the write's
 * transaction) and on every record shown, `capabilities.custom` and
 * `customFields` in GET /v1/lists/{subject}, and the values gone with the
 * record's purge. `listFields()` gives the list's `custom.<key>` filters,
 * sorts and `fields=` names, per request (they are the tenant's).
 */
@RecordExtension()
@Injectable()
export class CustomFieldsExtension implements RecordHooks {
  readonly shows = ['custom'];
  readonly capability = CUSTOM_CAPABILITY;

  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly values: CustomValuesService,
    private readonly fields: CustomFieldsService,
    private readonly records: Records,
  ) {}

  present(_principal: Principal, views: Record<string, unknown>[]) {
    return this.values.present(this.record.subject, views);
  }

  async created({ row, input }: RecordChange) {
    await this.values.created(this.record.subject, row.id, input.custom);
  }

  async updating({
    before,
    by,
    input,
  }: {
    before: RecordRow;
    by: Principal;
    input: Record<string, unknown>;
  }) {
    await this.values.updated(by, this.record, before.id, input.custom);
  }

  async purged({ ids }: { ids: readonly string[] }) {
    await this.values.forget(this.record.subject, ids);
  }

  /** The tenant's active fields, as a client builds a table or a filter bar from them. */
  async describe() {
    const fields = await this.fields.definitions(this.record.subject);
    return {
      customFields: fields.map((field) => ({
        name: `custom.${field.key}`,
        key: field.key,
        label: field.label,
        type: field.type,
        options: field.options,
        required: field.required,
        filterable: field.filterable,
        sortable: field.sortable,
      })),
    };
  }

  /**
   * The list fields of the tenant's custom fields (`custom.<key>`): the
   * engine extends the record's list with them for each request
   * (RecordHooks.listFields).
   */
  listFields(_principal: Principal) {
    return this.values.listFields(
      this.record.subject,
      this.records.of(this.record.subject).feature.table,
    );
  }
}
