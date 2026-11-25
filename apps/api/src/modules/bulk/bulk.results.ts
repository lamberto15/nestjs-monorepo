import { HttpException } from '@nestjs/common';
import { AuthorizationError } from '@nestjs/authorization';
import { infrastructureError } from '../../core/http/infrastructure-errors.js';
import { problemCode } from '../../core/http/problem-details.filter.js';
import type {
  BulkItemError,
  BulkItemResult,
  BulkResult,
} from './bulk.types.js';

/**
 * An item's failure, from what its action threw: a 4xx as the record's own
 * route would answer it (its `code`, `message`, field `errors`), a
 * database error the API answers as one (a unique violation no hook
 * mapped: 409 `conflict`), or a refused permission check. Undefined for
 * anything else (the database gone, overloaded): that stops the run.
 */
export function itemError(error: unknown): BulkItemError | undefined {
  if (!(
    error instanceof HttpException || error instanceof AuthorizationError
  )) {
    const answered = infrastructureError(error);
    return answered ? itemError(answered) : undefined;
  }
  if (error instanceof AuthorizationError) {
    return { code: 'forbidden', message: 'Forbidden' };
  }
  if (!(error instanceof HttpException)) return undefined;
  const status = error.getStatus();
  if (status < 400 || status >= 500) return undefined;
  const body = error.getResponse();
  const { code, message, errors, fields } = (
    typeof body === 'object' ? body : { message: body }
  ) as {
    code?: unknown;
    message?: unknown;
    errors?: unknown;
    fields?: unknown;
  };
  const text = typeof message === 'string' ? message : error.message;
  // A validation's `errors`, or the fields a permission refused (`field_forbidden`).
  const paths: BulkItemError['errors'] = Array.isArray(errors)
    ? (errors as BulkItemError['errors'])
    : Array.isArray(fields)
      ? (fields as string[]).map((path) => ({ path, message: text }))
      : [];
  return {
    code: typeof code === 'string' ? code : problemCode(status),
    message: text,
    ...(paths!.length > 0 && { errors: paths }),
  };
}

/** The result of an id the selection did not yield: not there, or not the caller's to act on. */
export const skipped = (id: string, action: string): BulkItemResult => ({
  id,
  status: 'skipped',
  error: {
    code: 'not_found',
    message: `Not found, or not yours to ${action}.`,
  },
});

/** Counts a run's items exactly, and keeps their results up to `cap`. */
export class BulkTally {
  done = 0;
  failed = 0;
  skipped = 0;
  private readonly results: BulkItemResult[] = [];
  private truncated = false;

  constructor(private readonly cap = Number.POSITIVE_INFINITY) {}

  add(result: BulkItemResult) {
    this[result.status]++;
    if (this.results.length < this.cap) {
      this.results.push(result);
    } else {
      this.truncated = true;
    }
  }

  /** The items acted on so far (skipped ones aside). */
  get processed() {
    return this.done + this.failed;
  }

  /** The outcome; with `ids`, the results in the order they were sent. */
  result(ids?: readonly string[]): BulkResult {
    const order = ids && new Map(ids.map((id, index) => [id, index]));
    const results = order
      ? [...this.results].sort(
          (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
        )
      : this.results;
    return {
      done: this.done,
      failed: this.failed,
      skipped: this.skipped,
      results,
      ...(this.truncated && { truncated: true }),
    };
  }
}
