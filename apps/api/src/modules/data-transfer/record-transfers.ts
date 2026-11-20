import { TransactionHost } from '@nestjs-cls/transactional';
import { AuthorizationService } from '@nestjs/authorization';
import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DatabaseTransactions } from '../../core/database/database.js';
import type { List, ListQuery } from '../../core/http/list-query.js';
import { cursorValues } from '../../core/http/list-sort.js';
import { WALK_BATCH } from '../../core/http/pagination.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { recordValues, type RecordRow } from '../records/record.js';
import { assertWritableFields } from '../records/record.routes.js';
import {
  type RecordRegistration,
  Records,
} from '../records/records.service.js';
import {
  TransferColumns,
  type TransferColumnSource,
} from './data-transfer.columns.js';
import type {
  ImportColumn,
  ImportRowError,
  TransferColumn,
} from './data-transfer.types.js';
import { TransferExtension } from './data-transfer.extension.js';
import { columnsOf } from './import-columns.js';
import { exportColumns, importSchema, matchKeys } from './record-transfer.js';

/** One valid row of an import, ready to write: its body, and the value it is matched by. */
export interface ImportRow {
  row: number;
  body: Record<string, unknown>;
  match?: string;
}

/**
 * The records that opted into transfers (`DataTransferModule.forRecord()`),
 * by their path, and how a transfer reads and writes them: through the
 * record's list and store, as its routes do, so its permissions, filters,
 * field-level redaction and add-ons' hooks apply.
 */
@Injectable()
export class RecordTransfers {
  constructor(
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly authorization: AuthorizationService,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly discovery: DiscoveryService,
  ) {}

  /** The add-ons that bring columns of their own (`@TransferColumns()`). */
  private sources() {
    return this.discovery
      .getProviders({ metadataKey: TransferColumns.KEY })
      .flatMap((wrapper) =>
        wrapper.instance ? [wrapper.instance as TransferColumnSource] : [],
      );
  }

  /** The columns of an export: the record's, with the tenant's custom ones the add-ons bring. */
  async exportColumns(registration: RecordRegistration) {
    let columns: TransferColumn[] = exportColumns(registration);
    const extra: TransferColumn[] = [];
    for (const source of this.sources()) {
      const more = await source.exportColumns?.(registration);
      if (!more) continue;
      columns = columns.filter((column) => !more.replaces.includes(column.key));
      extra.push(...more.columns);
    }
    // Before the owner and the creation time, which close a file.
    const at = columns.findIndex((column) => column.key === 'ownerId');
    return at < 0 ? [...columns, ...extra] : columns.toSpliced(at, 0, ...extra);
  }

  /** Turns a file's row into what the add-ons put in the write's body, once per import. */
  async importReader(registration: RecordRegistration) {
    const readers: ((
      record: Record<string, unknown>,
    ) => Record<string, unknown>)[] = [];
    for (const source of this.sources()) {
      const reader = await source.importReader?.(registration);
      if (reader) readers.push(reader);
    }
    return (record: Record<string, unknown>) =>
      Object.assign({}, ...readers.map((reader) => reader(record))) as Record<
        string,
        unknown
      >;
  }

  /** What the add-ons would refuse in a row's body (a dry run's check of their part). */
  async importCheck(registration: RecordRegistration) {
    const checks: Awaited<
      ReturnType<NonNullable<TransferColumnSource['importCheck']>>
    >[] = [];
    for (const source of this.sources()) {
      const check = await source.importCheck?.(registration);
      if (check) checks.push(check);
    }
    return (body: Record<string, unknown>, mode: 'create' | 'update') =>
      checks.flatMap((check) => check(body, mode));
  }

  /** Every record that may be exported and imported. */
  all(): RecordRegistration[] {
    return this.records
      .all()
      .filter((registration) =>
        registration.extensions.some(
          (hooks) => hooks instanceof TransferExtension,
        ),
      );
  }

  /** The record a transfer names (its path), or undefined. */
  find(name: string): RecordRegistration | undefined {
    return this.all().find(
      (registration) => registration.declaration.path === name,
    );
  }

  /**
   * The list query of an export (its filters and sort, as the list route
   * takes them), validated against the record's list, refused (403
   * `field_forbidden`) on a field the principal may not use.
   */
  query(
    principal: Principal,
    registration: RecordRegistration,
    filters: Record<string, string>,
    sort?: string | null,
  ) {
    return registration.presenter.query(
      principal,
      sort ? { ...filters, sort } : filters,
    );
  }

  /**
   * The records the principal may read through the list, in its order
   * (`query.sort`, else newest first), WALK_BATCH at a time, by the keyset
   * its cursor uses (never an offset: memory stays one batch), each as the
   * API shows it to them (their add-ons' parts, less the fields they may
   * not read).
   */
  async *pages(
    principal: Principal,
    registration: RecordRegistration,
    { list, query }: { list: List; query: ListQuery },
  ): AsyncGenerator<Record<string, unknown>[]> {
    let current: ListQuery = {
      ...query,
      limit: WALK_BATCH,
      page: undefined,
      cursor: undefined,
      after: undefined,
      count: false,
    };
    for (;;) {
      const { items } = await registration.store.findPage(
        principal,
        list,
        current,
      );
      if (items.length === 0) return;
      yield await registration.presenter.many(principal, items);
      if (items.length < WALK_BATCH) return;
      const last = items.at(-1)!;
      current = {
        ...current,
        cursor: last.id,
        after: query.sort?.length
          ? cursorValues(query.sort, last as Record<string, unknown>)
          : undefined,
      };
    }
  }

  /** The columns of an import the principal may fill: the record's create body, less the fields they may not set. */
  async importColumns(
    principal: Principal,
    registration: RecordRegistration,
  ): Promise<ImportColumn[]> {
    const columns = columnsOf(importSchema(registration.declaration));
    const forbidden = await this.access.forbiddenFields(
      principal,
      'create',
      registration.declaration.subject,
      Object.fromEntries(columns.map((column) => [column.name, true])),
    );
    const extra: ImportColumn[] = [];
    for (const source of this.sources()) {
      extra.push(...((await source.importColumns?.(registration)) ?? []));
    }
    return [
      ...columns.filter((column) => !forbidden.includes(column.name)),
      ...extra,
    ];
  }

  /** Whether the principal may import into the record: create it, and with `matchOn`, update it. */
  async mayImport(
    principal: Principal,
    registration: RecordRegistration,
    matchOn?: string,
  ) {
    const { subject } = registration.declaration;
    return (
      (await this.access.can(principal, 'create', subject)) &&
      (!matchOn || (await this.access.can(principal, 'update', subject)))
    );
  }

  /** The keys `matchOn` may name for this record. */
  matchKeys(registration: RecordRegistration) {
    return matchKeys(registration.declaration);
  }

  /**
   * Writes a group of valid rows in one transaction, each as the record's
   * POST (or, matched, its PATCH) would: the field-level permissions, then
   * the store, whose add-ons' hooks, audit entry and event go with it. A
   * row's 4xx rolls the group back; each row is then written alone, so one
   * bad row is reported alone. Anything else fails the import. Returns the
   * rows written and the refusals.
   */
  async write(
    principal: Principal,
    registration: RecordRegistration,
    rows: readonly ImportRow[],
    matchOn?: string,
  ): Promise<{ written: number; errors: ImportRowError[] }> {
    try {
      await this.txHost.withTransaction(async () => {
        for (const row of rows) {
          await this.writeOne(principal, registration, row, matchOn);
        }
      });
      return { written: rows.length, errors: [] };
    } catch (error) {
      if (!refusal(error, 0)) throw error;
    }
    let written = 0;
    const errors: ImportRowError[] = [];
    for (const row of rows) {
      try {
        await this.txHost.withTransaction(() =>
          this.writeOne(principal, registration, row, matchOn),
        );
        written++;
      } catch (error) {
        const refused = refusal(error, row.row);
        if (!refused) throw error;
        errors.push(...refused);
      }
    }
    return { written, errors };
  }

  private async writeOne(
    principal: Principal,
    { declaration, store, feature }: RecordRegistration,
    { body, match }: ImportRow,
    matchOn?: string,
  ) {
    if (!matchOn) {
      await assertWritableFields(
        this.access,
        principal,
        'create',
        declaration,
        body,
      );
      await store.create(principal, recordValues(declaration, body), {
        input: body,
      });
      return;
    }
    const found = await this.matched(
      principal,
      feature.table,
      declaration.subject,
      matchOn,
      match!,
    );
    await store.update(principal, found.id, recordValues(declaration, body), {
      input: body,
      check: async (row) => {
        await this.authorization.authorize(
          feature.policy as never,
          'update' as never,
          principal,
          row,
        );
        await assertWritableFields(
          this.access,
          principal,
          'update',
          declaration,
          body,
          row,
        );
      },
    });
  }

  /**
   * The live record `matchOn` names, among those the principal may read: a
   * record they may not read is refused as one that doesn't exist, so a
   * file can't probe which values exist.
   */
  private async matched(
    principal: Principal,
    table: RecordRegistration['feature']['table'],
    subject: string,
    matchOn: string,
    value: string,
  ): Promise<RecordRow> {
    const column = table[matchOn]!;
    const db = this.txHost.tx;
    const valid = matchOn !== 'id' || UUID.test(value);
    const [row] = valid
      ? await db
          .select({ id: table.id })
          .from(table as unknown as PgTable)
          .where(
            and(
              eq(column, value),
              table.deletedAt ? isNull(table.deletedAt) : undefined,
              await this.access.sqlFilter(principal, subject, 'read'),
            ),
          )
          .limit(1)
      : [];
    if (!row) {
      throw new NotFoundException(`No record whose ${matchOn} is "${value}".`);
    }
    return row as RecordRow;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A row's refusal, from what a write threw: a 4xx (as the route would
 * answer it) names its fields when it can. Undefined for anything else
 * (the database gone): that fails the import.
 */
export function refusal(
  error: unknown,
  row: number,
): ImportRowError[] | undefined {
  if (!(error instanceof HttpException) || error.getStatus() >= 500) {
    return undefined;
  }
  const body = error.getResponse();
  const { errors, fields, message } = (
    typeof body === 'object' ? body : { message: body }
  ) as {
    errors?: { path?: string | string[]; message?: string }[];
    fields?: string[];
    message?: string | string[];
  };
  if (Array.isArray(errors) && errors.length) {
    return errors.map((issue) => ({
      row,
      path: Array.isArray(issue.path)
        ? issue.path.join('.')
        : (issue.path ?? ''),
      message: issue.message ?? error.message,
    }));
  }
  const text = Array.isArray(message)
    ? message.join(' ')
    : (message ?? error.message);
  if (Array.isArray(fields) && fields.length) {
    return fields.map((field) => ({ row, path: field, message: text }));
  }
  return [{ row, path: '', message: text }];
}
