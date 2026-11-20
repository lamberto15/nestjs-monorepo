import { InjectTransaction } from '@nestjs-cls/transactional';
import { Inject, Injectable } from '@nestjs/common';
import { text } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { FilterField } from '../../core/http/list-query.js';
import type { Database } from '../../core/database/database.js';
import type { RecordDeclaration, RecordTable } from '../records/record.js';
import {
  referenceKeyNames,
  referenceKeyValues,
} from '../records/record-keys.js';
import {
  InjectRecord,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import type {
  NumberedSubject,
  NumberingFieldKind,
} from './naming-series.registry.js';
import { NamingSeriesService } from './naming-series.service.js';

/** The column a numbered record's table takes: `recordTable(INVOICE, { columns: numberColumns() })`. */
export const numberColumns = () => ({ number: text('number') });

/** What a numbered record's create body takes: `recordSchemas(INVOICE, { body: NUMBER_BODY })`. */
export const NUMBER_BODY = {
  namingSeriesId: z
    .uuid()
    .describe(
      "The naming series to number it by (GET /v1/naming-series); else the tenant's rules choose.",
    ),
};

/** What a numbered record shows: `recordSchemas(INVOICE, { response: NUMBER_RESPONSE })`. */
export const NUMBER_RESPONSE = {
  number: z
    .string()
    .nullable()
    .describe(
      'Its human-readable number, gapless per tenant, assigned when it is created. Read-only; null for records from before numbering.',
    ),
};

/** How numbering reads each field kind from a create body; the others (long text, money, json, references) a series can't use. */
const KINDS: Record<string, NumberingFieldKind> = {
  string: 'text',
  enum: 'text',
  int: 'number',
  decimal: 'number',
  date: 'date',
  datetime: 'datetime',
  bool: 'boolean',
};

/** The number's format when no series is set: the subject's initials (`InvoiceLine` is `IL`, `Invoice` is `INV`), per year, five digits. */
export type NumberFormat = NumberedSubject['declared'];

/** A record as a numbered subject (SequencesModule.forFeature), its format from `format` over the defaults. */
export function numberedSubject(
  record: RecordDeclaration,
  format: NumberFormat = {},
  field?: string,
): NumberedSubject {
  const words = record.subject.match(/[A-Z][a-z0-9]*/g) ?? [record.subject];
  const initials =
    words.length > 1
      ? words.map((word) => word[0]).join('')
      : record.subject.slice(0, 3);
  return {
    subject: record.subject,
    sequence: record.subject[0]!.toLowerCase() + record.subject.slice(1),
    declared: {
      prefix: initials.toUpperCase(),
      perYear: true,
      width: 5,
      ...format,
    },
    fields: Object.fromEntries([
      ...Object.entries(record.fields).flatMap(([name, f]) => {
        const kind = KINDS[(f as { kind: string }).kind];
        // The numbered field itself is what the pattern makes.
        return kind && name !== field ? [[name, kind]] : [];
      }),
      // A reference prints its record's key ({product}: HL), and its key's parents ({product_client}: QWERT).
      ...(field
        ? referenceKeyNames(record).map((name) => [name, 'text' as const])
        : []),
    ]),
  };
}

/**
 * What numbering adds to a record: the number, taken in the create's
 * transaction (a rollback leaves no gap), `?number=` and `?sort=number` on
 * its list. The number never changes afterwards.
 */
@RecordExtension()
@Injectable()
export class NumberingExtension implements RecordHooks {
  readonly shows = ['number'];
  readonly capability = 'numbered';

  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly series: NamingSeriesService,
  ) {}

  filters(table: RecordTable): Record<string, FilterField> {
    return {
      number: {
        column: table.number as FilterField['column'],
        type: 'string',
        ops: ['eq', 'in', 'contains', 'startsWith'],
        sortable: true,
      },
    };
  }

  async creating({ input }: { input: Record<string, unknown> }) {
    const { formatted } = await this.series.next(this.record.subject, {
      seriesId: input.namingSeriesId as string | undefined,
      values: input,
    });
    return { number: formatted };
  }
}

/** The field `SequencesModule.forRecord(…, { field })` numbers. */
export const NUMBERED_FIELD = Symbol('NUMBERED_FIELD');

/**
 * A record's key from a naming series (`forRecord(…, { field })`): a new
 * record whose field is empty takes the next number, in the create's
 * transaction; a value given is kept. The pattern may print the record's
 * fields and its references' keys (`{product}`, `{product_client}`,
 * record-keys.ts).
 */
@RecordExtension()
@Injectable()
export class FieldNumberingExtension implements RecordHooks {
  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    @Inject(NUMBERED_FIELD) private readonly field: string,
    private readonly series: NamingSeriesService,
    @InjectTransaction() private readonly db: Database,
  ) {}

  async creating({
    input,
    values,
  }: {
    input: Record<string, unknown>;
    values: Record<string, unknown>;
  }) {
    if (values[this.field]) return;
    const { formatted } = await this.series.next(this.record.subject, {
      seriesId: input.namingSeriesId as string | undefined,
      values: {
        ...input,
        ...(await referenceKeyValues(this.db, this.record, input)),
      },
    });
    return { [this.field]: formatted };
  }
}
