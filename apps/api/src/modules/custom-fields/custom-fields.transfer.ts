import { Injectable } from '@nestjs/common';
import {
  TransferColumns,
  type TransferColumnSource,
} from '../data-transfer/data-transfer.columns.js';
import type {
  ImportColumn,
  TransferColumn,
} from '../data-transfer/data-transfer.types.js';
import type { RecordRegistration } from '../records/records.service.js';
import type { CustomFieldDefinition } from './custom-field.types.js';
import { customValuesSchema } from './custom-field.values.js';
import {
  CUSTOM_CAPABILITY,
  CustomFieldsService,
} from './custom-fields.service.js';

const NUMBER = /^-?\d+(\.\d+)?$/;

/** A file's cell as the field's value takes it; left as it is when it doesn't fit (the check says why). */
function cell(field: CustomFieldDefinition, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  switch (field.type) {
    case 'number':
      return NUMBER.test(value) ? Number(value) : value;
    case 'boolean':
      return /^true$/i.test(value)
        ? true
        : /^false$/i.test(value)
          ? false
          : value;
    case 'multiSelect':
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    default:
      return value;
  }
}

const importType = (field: CustomFieldDefinition): ImportColumn['type'] =>
  field.type === 'number'
    ? 'number'
    : field.type === 'boolean'
      ? 'boolean'
      : field.type === 'date'
        ? 'date'
        : field.type === 'multiSelect'
          ? 'list'
          : 'text';

/**
 * The tenant's active custom fields as export and import columns,
 * `custom.<key>` (data-transfer finds this by `@TransferColumns()`): an
 * export has one column each instead of the `custom` object, an import
 * reads them into the body's `custom`, which the record's own write checks
 * (a refused value is that row's error, `custom.<key>`), and a dry run
 * checks the same way (importCheck()).
 */
@TransferColumns()
@Injectable()
export class CustomFieldsTransfer implements TransferColumnSource {
  constructor(private readonly fields: CustomFieldsService) {}

  private applies({ extensions }: RecordRegistration) {
    return extensions.some((hooks) => hooks.capability === CUSTOM_CAPABILITY);
  }

  async exportColumns(registration: RecordRegistration) {
    if (!this.applies(registration)) return { columns: [], replaces: [] };
    const fields = await this.fields.definitions(
      registration.declaration.subject,
    );
    return {
      replaces: ['custom'],
      columns: fields.map((field): TransferColumn => ({
        key: `custom.${field.key}`,
        value: (row) => {
          const value = (row.custom as Record<string, unknown> | undefined)?.[
            field.key
          ];
          return Array.isArray(value) ? value.join(', ') : value;
        },
        ...(field.type === 'date' && { type: 'date' as const }),
      })),
    };
  }

  async importColumns(registration: RecordRegistration) {
    if (!this.applies(registration)) return [];
    const fields = await this.fields.definitions(
      registration.declaration.subject,
    );
    return fields.map((field): ImportColumn => ({
      name: `custom.${field.key}`,
      type: importType(field),
      required: field.required && field.defaultValue == null,
      description: field.label,
      ...(field.options && { options: field.options.map((o) => o.value) }),
    }));
  }

  async importReader(registration: RecordRegistration) {
    const fields = this.applies(registration)
      ? await this.fields.definitions(registration.declaration.subject)
      : [];
    return (record: Record<string, unknown>) => {
      const custom: Record<string, unknown> = {};
      for (const field of fields) {
        const value = record[`custom.${field.key}`];
        if (value === undefined || value === '') continue;
        custom[field.key] = cell(field, value);
      }
      return Object.keys(custom).length > 0 ? { custom } : {};
    };
  }

  /** A dry run's check of `custom`: the one the record's write makes (CustomValuesService). */
  async importCheck(registration: RecordRegistration) {
    const fields = this.applies(registration)
      ? await this.fields.definitions(registration.declaration.subject)
      : [];
    return (body: Record<string, unknown>, mode: 'create' | 'update') => {
      if (!fields.length) return [];
      const parsed = customValuesSchema(fields, mode).safeParse(
        body.custom ?? {},
      );
      return parsed.success
        ? []
        : parsed.error.issues.map((issue) => ({
            path: ['custom', ...issue.path].join('.'),
            message: issue.message,
          }));
    };
  }
}
