import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import type { ImportMapping } from './import-mapping.js';

/** The file formats exports write and imports read. */
export const TRANSFER_FORMATS = ['csv', 'xlsx'] as const;
export type TransferFormat = (typeof TRANSFER_FORMATS)[number];

/** A column of an export: a key of the record as the API shows it, and its header (default: the key). */
export interface TransferColumn {
  key: string;
  header?: string;
  /**
   * `datetime`: a moment, shown as the reader's local time
   * (`2026-10-15 18:30:00`, an Excel date cell) under a header naming the
   * zone, `createdAt (Asia/Dubai)`. `date`: a calendar day, `2026-10-15`
   * (an Excel date cell, text in CSV).
   */
  type?: 'datetime' | 'date';
  /** Reads the cell when it isn't `row[key]` (money as `12.50 EUR`). */
  value?: (row: Record<string, unknown>) => unknown;
}

/**
 * A column of an import file, as its template and the catalog describe it:
 * read from the record's create schema, so what a template shows is what
 * the rows are checked against.
 */
export interface ImportColumn {
  /** The header (a `datetime` column's gets the zone in a template: `dueAt (Asia/Dubai)`). */
  name: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'list';
  required: boolean;
  description?: string;
  /** The values allowed: Excel gets a dropdown. */
  options?: string[];
  /** Length for text, value for a number, entries for a list. */
  min?: number;
  max?: number;
  example?: unknown;
}

/** The limits an accepted import keeps, resolved when it was uploaded. */
export interface ImportLimits {
  maxBytes: number;
  maxRows: number;
}

/**
 * What a transfer job carries: the tenant it was started in (the worker
 * runs it there, TenantWorkerHost) and the work. The principal is data: the
 * worker looks it up again before anything runs.
 */
export type TransferJob = TenantEnvelope &
  (
    | {
        kind: 'export';
        /** The record's path: `test-items`. */
        name: string;
        format: TransferFormat;
        /** The list's filters as the caller sent them; the worker parses them again. */
        filters: Record<string, string>;
        /** The list's `sort` (`-createdAt,title`). Unset: newest first. */
        sort?: string;
        /** The file's time zone. */
        timezone: string;
        /** Who asked for it in code (`report:<id>`): in the finished event. */
        tag?: string;
        principal: RequestPrincipal;
      }
    | {
        kind: 'import';
        name: string;
        format: TransferFormat;
        /** The upload, on the private disk under the tenant's prefix; deleted once read. */
        key: string;
        dryRun: boolean;
        /** Update the record this column finds instead of creating one. */
        matchOn?: string;
        mapping?: ImportMapping;
        limits: ImportLimits;
        principal: RequestPrincipal;
      }
  );

/** One problem of an imported row. */
export interface ImportRowError {
  /** The row's number in the file (1: the first after the header). */
  row: number;
  path: string;
  message: string;
}

export type TransferResult =
  | { kind: 'export'; key: string; rows: number }
  | {
      kind: 'import';
      rows: number;
      imported: number;
      failed: number;
      dryRun: boolean;
      /** The error report (CSV), when some rows failed. */
      errorsKey?: string;
    };
