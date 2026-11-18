import { DiscoveryService } from '@nestjs/core';
import type { RecordRegistration } from '../records/records.service.js';
import type { ImportColumn, TransferColumn } from './data-transfer.types.js';

/**
 * Columns an add-on brings to a record's exports and imports, that depend
 * on the tenant (custom fields: `custom.<key>`). The add-on's module marks
 * a provider with `@TransferColumns()`; each method answers for the records
 * it applies to and nothing for the others. No list to edit here.
 */
export interface TransferColumnSource {
  /**
   * Export columns for the record, and the keys of what the record shows
   * (`shows`) that they replace (the object `custom` becomes one column per field).
   */
  exportColumns?(
    registration: RecordRegistration,
  ): Promise<{ columns: TransferColumn[]; replaces: string[] }>;
  /** Import columns for the record: they join its template, catalog and mappings. */
  importColumns?(registration: RecordRegistration): Promise<ImportColumn[]>;
  /**
   * Read once per import: turns a row (its mapped columns) into the part of
   * the write's body that is the add-on's (`{ custom: { region: 'EU' } }`).
   * What it returns is checked by the add-on's hooks when the row is written.
   */
  importReader?(
    registration: RecordRegistration,
  ): Promise<(record: Record<string, unknown>) => Record<string, unknown>>;
  /**
   * Read once per dry run, which writes nothing: what the add-on's hooks
   * would refuse in a row's body (its importReader() part), as the write's
   * errors (`custom.<key>`).
   */
  importCheck?(
    registration: RecordRegistration,
  ): Promise<
    (
      body: Record<string, unknown>,
      mode: 'create' | 'update',
    ) => { path: string; message: string }[]
  >;
}

/** Marks the provider that implements TransferColumnSource. */
export const TransferColumns = DiscoveryService.createDecorator<void>();
