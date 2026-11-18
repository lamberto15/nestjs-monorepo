import type { AssignmentStatus } from './approvals.tables.js';

/**
 * How a stage completes and whether approval is needed at all: pure
 * functions of a policy's data (approval-policy.ts), asked in the
 * transaction of each change.
 */

/** One approver's standing, as a stage mode sees it. */
export interface StageVote {
  approverId: string;
  status: AssignmentStatus;
  decidedAt: Date | null;
  /**
   * Who decided: the approver, or their delegate. One person's decision
   * covers every assignment they hold or stand in for, so people are
   * counted (distinct `decidedBy`), not assignments.
   */
  decidedBy: string | null;
}

/**
 * A stage's state after a change. `unreachable`: nobody (or too few) left
 * to decide it: the request fails (`no_approvers`).
 */
export type StageOutcome =
  'pending' | 'approved' | 'rejected' | 'changes_requested' | 'unreachable';

export type StageMode =
  { type: 'any' } | { type: 'all' } | { type: 'quorum'; n: number };

/** The votes still counting: an approver closed out counts for nothing. */
const counting = (votes: readonly StageVote[]) =>
  votes.filter((vote) => vote.status !== 'closed');

/**
 * `any`: the first decision decides, whatever it is. `all`: everyone
 * approves; one rejection or request for changes decides at once.
 * `quorum`: `n` people approve, never fewer: once `n` is out of reach the
 * stage is rejected when someone rejected, `unreachable` otherwise.
 */
export function stageOutcome(
  mode: StageMode,
  votes: readonly StageVote[],
): StageOutcome {
  const live = counting(votes);
  switch (mode.type) {
    case 'any': {
      if (!live.length) return 'unreachable';
      const first = live
        .filter((vote) => vote.status !== 'pending' && vote.decidedAt)
        .sort((a, b) => a.decidedAt!.getTime() - b.decidedAt!.getTime())[0];
      return (first?.status as StageOutcome | undefined) ?? 'pending';
    }
    case 'all': {
      if (live.some((vote) => vote.status === 'rejected')) return 'rejected';
      if (live.some((vote) => vote.status === 'changes_requested')) {
        return 'changes_requested';
      }
      if (!live.length) return 'unreachable';
      return live.every((vote) => vote.status === 'approved')
        ? 'approved'
        : 'pending';
    }
    case 'quorum': {
      if (live.some((vote) => vote.status === 'changes_requested')) {
        return 'changes_requested';
      }
      const approvers = new Set(
        live
          .filter((vote) => vote.status === 'approved')
          .map((vote) => vote.decidedBy ?? vote.approverId),
      ).size;
      if (approvers >= mode.n) return 'approved';
      const undecided = live.filter((vote) => vote.status === 'pending').length;
      if (approvers + undecided >= mode.n) return 'pending';
      return live.some((vote) => vote.status === 'rejected')
        ? 'rejected'
        : 'unreachable';
    }
  }
}

export const COMPARISONS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'exists',
] as const;

/** A policy's `when`: a value of the proposed change, or `all` / `any` / `not` of others. */
export type ApprovalCondition =
  | {
      type: 'payload';
      path: string;
      op: (typeof COMPARISONS)[number];
      value?: unknown;
    }
  | { type: 'all' | 'any'; conditions: ApprovalCondition[] }
  | { type: 'not'; condition: ApprovalCondition };

/** A dotted path into the payload: `amount`, `lines.0.total`. */
const valueAt = (payload: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value !== null && typeof value === 'object'
          ? (value as Record<string, unknown>)[key]
          : undefined,
      payload,
    );

const compare = (op: string, difference: number) =>
  op === 'gt'
    ? difference > 0
    : op === 'gte'
      ? difference >= 0
      : op === 'lt'
        ? difference < 0
        : difference <= 0;

/** Whether the condition holds for this payload (none: it does). */
export function holds(
  condition: ApprovalCondition | null | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!condition) return true;
  switch (condition.type) {
    case 'all':
      return condition.conditions.every((child) => holds(child, payload));
    case 'any':
      return condition.conditions.some((child) => holds(child, payload));
    case 'not':
      return !holds(condition.condition, payload);
    case 'payload':
      break;
  }
  const actual = valueAt(payload, condition.path);
  const expected = condition.value;
  switch (condition.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'in':
      return (expected as unknown[]).includes(actual);
    case 'notIn':
      return !(expected as unknown[]).includes(actual);
    default:
      // Numbers compare as numbers, text (ISO dates) as text, nothing else.
      if (typeof actual === 'number' && typeof expected === 'number') {
        return compare(condition.op, actual - expected);
      }
      if (typeof actual === 'string' && typeof expected === 'string') {
        return compare(
          condition.op,
          actual < expected ? -1 : actual > expected ? 1 : 0,
        );
      }
      return false;
  }
}
