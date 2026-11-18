import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';

/** The queue of bulk runs too large for a request. */
export const BULK = 'bulk';

/** Ids one request may name; more: a `filter`. */
export const MAX_BULK_IDS = 500;
/** Item results a queued job keeps (its counts are exact). */
export const MAX_BULK_RESULTS = 10_000;
/** A queued run reports its progress every this many items. */
export const BULK_PROGRESS_EVERY = 100;

/**
 * What a record's bulk route does to many of its records, each as the
 * record's own route does it. `restore` only for a record with a recycle bin.
 */
export const BULK_ACTIONS = ['delete', 'restore', 'update'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/** What a run acts on: these ids, or every record matching the list's filters. */
export interface BulkSelection {
  ids?: string[];
  filter?: Record<string, unknown>;
}

/** A request to act on many records of one subject. */
export interface BulkRequest extends BulkSelection {
  action: BulkAction;
  input?: unknown;
  ip?: string;
}

/** Why an item failed: the problem its own route would have answered. */
export interface BulkItemError {
  code: string;
  message: string;
  errors?: { path: string; message: string }[];
}

/** What happened to one record. */
export type BulkItemResult =
  | { id: string; status: 'done' }
  | { id: string; status: 'failed' | 'skipped'; error: BulkItemError };

/** A run's outcome: exact counts, the items' results (a queued run keeps MAX_BULK_RESULTS). */
export interface BulkResult {
  done: number;
  failed: number;
  skipped: number;
  results: BulkItemResult[];
  /** More results than were kept. */
  truncated?: boolean;
}

/**
 * A queued run. The selection and input travel raw: the worker parses them
 * again. It names the tenant it was started in (TenantEnvelope): the worker
 * runs it there and nowhere else.
 */
export interface BulkJob extends TenantEnvelope, BulkRequest {
  readonly tenantId: string;
  /** Never the system principal: a queued job's principal is data. */
  principal: RequestPrincipal;
  subject: string;
}
