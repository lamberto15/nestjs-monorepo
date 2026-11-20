import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { type AnyPgColumn, type PgTable, text } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import type { FilterField } from '../../core/http/list-query.js';
import type { AnyField } from '../fields/field.js';
import type { RecordDeclaration, RecordTable } from '../records/record.js';
import {
  InjectRecord,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import {
  declarationOfTable,
  includeNameOf,
  recordTableOf,
} from '../records/record-relations.js';
import type {
  NumberedSubject,
  NumberingFieldKind,
} from './naming-series.registry.js';
import {
  NamingSeriesService,
  type ResolveValues,
} from './naming-series.service.js';

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
  let fields: Record<string, NumberingFieldKind> | undefined;
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
    // Read when a series is checked or taken, not here: a referenced record's table may load later.
    get fields() {
      return (fields ??= {
        ...Object.fromEntries(
          [...referencedFields(record)].map(([name, { kind }]) => [name, kind]),
        ),
        ...Object.fromEntries(
          Object.entries(record.fields).flatMap(([name, f]) => {
            const kind = KINDS[(f as AnyField).kind];
            // The numbered field itself is what the pattern makes.
            return kind && name !== field ? [[name, kind]] : [];
          }),
        ),
      });
    },
  };
}

/** How far up a series reads referenced records: D → C → B → A is 3; each level a series uses is one lookup. */
export const MAX_REFERENCE_DEPTH = 5;

/** A step up a chain of references: the reference field and the record it points to. */
interface ReferenceStep {
  /** The reference on the record below: `companyId`. */
  readonly reference: string;
  readonly target: RecordDeclaration;
}

/** A referenced record's field as a series reads it: `company_code`, `c_b_a_code`. */
interface ReferencedField {
  /** The references followed from the numbered record, nearest first. */
  readonly path: readonly ReferenceStep[];
  /** The field of the last record on the path: `code`. */
  readonly field: string;
  readonly kind: NumberingFieldKind;
}

const REFERENCED = new WeakMap<
  RecordDeclaration,
  Map<string, ReferencedField>
>();

/**
 * What a series may read of the records a record refers to, up to
 * MAX_REFERENCE_DEPTH levels: each one's fields, named by the references
 * followed (`cId` → `c`) then the field: `c_code`, `c_b_code`,
 * `c_b_a_code`. A series picks by them (a condition `company_code` is GLX)
 * and prints them (`.{company_code}.-.####`). Read once tables are made.
 */
function referencedFields(record: RecordDeclaration) {
  const known = REFERENCED.get(record);
  if (known) return known;
  const found = new Map<string, ReferencedField>();
  const walk = (
    declaration: RecordDeclaration,
    path: readonly ReferenceStep[],
    prefix: string,
  ) => {
    if (path.length === MAX_REFERENCE_DEPTH) return;
    for (const [reference, f] of Object.entries(declaration.fields) as [
      string,
      AnyField,
    ][]) {
      const table = f.kind === 'ref' ? f.options.ref?.() : undefined;
      const target = table ? declarationOfTable(table) : undefined;
      if (!target) continue;
      const steps = [...path, { reference, target }];
      const name = `${prefix}${includeNameOf(reference)}`;
      for (const [field, tf] of Object.entries(target.fields) as [
        string,
        AnyField,
      ][]) {
        const kind = KINDS[tf.kind];
        if (kind) found.set(`${name}_${field}`, { path: steps, field, kind });
      }
      walk(target, steps, `${name}_`);
    }
  };
  walk(record, [], '');
  REFERENCED.set(record, found);
  return found;
}

/**
 * The referenced records each transaction has read, by subject and id: an
 * import's rows share their parents (the same company, 200 rows a group),
 * so each is read once per transaction, not once per row.
 */
const READ = new WeakMap<object, Map<string, Record<string, unknown> | null>>();

/**
 * The values of referenced records' fields a series reads, for a create
 * body: following each chain one record at a time, in the create's
 * transaction (the tenant's). Read whether or not the creator may read
 * those records: an administrator chose to print them in the number.
 */
function referencedValues(
  txHost: TransactionHost<DatabaseTransactions>,
  record: RecordDeclaration,
  input: Readonly<Record<string, unknown>>,
): ResolveValues {
  return async (names) => {
    const tx = txHost.tx as object;
    const read = READ.get(tx) ?? new Map();
    READ.set(tx, read);
    const load = async (target: RecordDeclaration, id: string) => {
      const key = `${target.subject}\u0000${id}`;
      if (!read.has(key)) {
        const table = recordTableOf(target) as unknown as PgTable &
          Record<string, AnyPgColumn>;
        const [row] = (await txHost.tx
          .select()
          .from(table)
          .where(eq(table.id!, id))
          .limit(1)) as Record<string, unknown>[];
        read.set(key, row ?? null);
      }
      return read.get(key) ?? null;
    };
    const fields = referencedFields(record);
    const values: Record<string, unknown> = {};
    for (const name of names) {
      const known = fields.get(name);
      if (!known) continue;
      let row: Readonly<Record<string, unknown>> | null = input;
      for (const { reference, target } of known.path) {
        const id: unknown = row?.[reference];
        row = typeof id === 'string' ? await load(target, id) : null;
      }
      const value = row?.[known.field];
      // A date-time column reads as a Date; a series reads the body's ISO text.
      if (value !== undefined && value !== null) {
        values[name] = value instanceof Date ? value.toISOString() : value;
      }
    }
    return values;
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
    private readonly txHost: TransactionHost<DatabaseTransactions>,
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
      resolve: referencedValues(this.txHost, this.record, input),
    });
    return { number: formatted };
  }
}

/** The field `SequencesModule.forRecord(…, { field })` numbers. */
export const NUMBERED_FIELD = Symbol('NUMBERED_FIELD');

/**
 * The field `forRecord(…, { field })` numbers must be an optional, unique
 * text field of the record: a create may leave it empty for the series to
 * fill, and a number names one record (as Frappe's series name a document
 * by its primary key); its unique index serves the check for taken ones.
 */
export function assertNumberedField(record: RecordDeclaration, field: string) {
  const f = record.fields[field] as AnyField | undefined;
  if (
    f?.kind !== 'string' ||
    !f.options.optional ||
    !f.options.unique ||
    f.options.readOnly
  ) {
    throw new Error(
      `${record.subject}: SequencesModule.forRecord numbers "${field}", which must be an optional, unique, writable string field of it.`,
    );
  }
}

/**
 * A record's own field from a naming series (`forRecord(…, { field })`): a
 * new record whose field is empty takes the next number, in the create's
 * transaction (no gap on a rollback); a value given is kept. A number a
 * record already holds (typed in) is skipped, so a value typed in never
 * blocks the series. Frappe fails the insert there instead, until the
 * counter is moved by hand. The pattern may print the record's other fields.
 */
@RecordExtension()
@Injectable()
export class FieldNumberingExtension implements RecordHooks {
  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    @Inject(NUMBERED_FIELD) private readonly field: string,
    private readonly series: NamingSeriesService,
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
  ) {}

  async creating({
    input,
    values,
  }: {
    input: Record<string, unknown>;
    values: Record<string, unknown>;
  }) {
    if (values[this.field]) return;
    // Each take moves the counter on, so this ends: past the records holding the numbers ahead.
    for (;;) {
      const { formatted } = await this.series.next(this.record.subject, {
        seriesId: input.namingSeriesId as string | undefined,
        values: input,
        resolve: referencedValues(this.txHost, this.record, input),
      });
      if (!(await this.taken(formatted))) return { [this.field]: formatted };
    }
  }

  /** Whether a record of the tenant holds the value: a live one, as its unique index counts. */
  private async taken(value: string) {
    const table = recordTableOf(this.record) as unknown as PgTable &
      Record<string, AnyPgColumn>;
    const [row] = await this.db
      .select({ id: table.id! })
      .from(table)
      .where(
        and(
          eq(table[this.field]!, value),
          this.record.softDelete ? isNull(table.deletedAt!) : undefined,
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}
