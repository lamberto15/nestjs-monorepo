import { and, eq, exists, ilike, or, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { escapeLike, listQuery } from '../../core/http/list-query.js';
import { apiClients, memberships, users } from '../auth/auth.tables.js';
import { auditLog } from '../audit/audit.tables.js';
import { SIGN_IN_ACTIONS } from '../audit/sign-in-actions.js';

/**
 * Entries whose actor matches a LIKE pattern: the label the entry stored
 * (an address, `admin as user`, a client's name, `System: …`), or the
 * current name or address of the member, or the name of the API client, it
 * names. A member counts only through a membership in the entry's tenant, a
 * client only of that tenant: the entries are the caller's tenant's (row-level
 * security), so another tenant's people never match.
 */
const actorMatches = (pattern: string) =>
  or(
    ilike(auditLog.actorLabel, pattern),
    exists(
      new QueryBuilder()
        .select({ one: sql`1` })
        .from(users)
        .innerJoin(
          memberships,
          and(
            eq(memberships.userId, users.id),
            eq(memberships.tenantId, auditLog.tenantId),
          ),
        )
        .where(
          and(
            eq(auditLog.actor, sql`'user:' || ${users.id}::text`),
            or(ilike(users.name, pattern), ilike(users.email, pattern)),
          ),
        ),
    ),
    exists(
      new QueryBuilder()
        .select({ one: sql`1` })
        .from(apiClients)
        .where(
          and(
            eq(apiClients.tenantId, auditLog.tenantId),
            eq(auditLog.actor, sql`'client:' || ${apiClients.id}::text`),
            ilike(apiClients.name, pattern),
          ),
        ),
    ),
  )!;

/** What GET /v1/access/audit can be filtered, sorted and narrowed by. */
export const AUDIT_LIST = listQuery(
  {
    action: {
      column: auditLog.action,
      type: 'string',
      ops: ['eq', 'in', 'notIn', 'startsWith'],
      sortable: true,
    },
    actor: {
      column: auditLog.actor,
      type: 'string',
      ops: ['eq', 'in'],
      ref: 'principal',
    },
    // Who acted, by name or address rather than key: `?actorLabel.contains=ada`.
    actorLabel: {
      column: auditLog.actorLabel,
      type: 'string',
      ops: ['eq', 'contains', 'startsWith'],
      conditions: {
        eq: (value) => actorMatches(escapeLike(value as string)),
        contains: (value) => actorMatches(`%${escapeLike(value as string)}%`),
        startsWith: (value) => actorMatches(`${escapeLike(value as string)}%`),
      },
    },
    targetType: {
      column: auditLog.targetType,
      type: 'string',
      ops: ['eq', 'in', 'isNull'],
    },
    targetId: { column: auditLog.targetId, type: 'string', ops: ['eq'] },
    at: {
      column: auditLog.at,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  {
    select: [
      'id',
      'tenantId',
      'at',
      'actor',
      'actorLabel',
      'actorName',
      'action',
      'targetType',
      'targetId',
      'details',
      'ip',
    ],
  },
);

const signInMethod = sql<string>`${auditLog.details}->>'method'`;
const signInResult = sql<string>`case when ${auditLog.action} = ${SIGN_IN_ACTIONS.succeeded} then 'success' else 'failure' end`;

/**
 * What GET /v1/access/sign-ins can be filtered, sorted and narrowed by: the
 * sign-ins of this tenant's members (successes and wrong passwords), by
 * user, method and result. Rows of the audit log that `signInEntries` (the
 * partial indexes' predicate) selects; row-level security keeps them to the
 * tenant.
 */
export const SIGN_IN_LIST = listQuery(
  {
    user: {
      column: auditLog.actor,
      type: 'string',
      ops: ['eq', 'in'],
      ref: 'principal',
    },
    method: {
      column: signInMethod,
      type: 'string',
      ops: ['eq', 'in', 'startsWith'],
    },
    result: {
      column: signInResult,
      type: 'enum',
      values: ['success', 'failure'],
      ops: ['eq'],
      conditions: {
        eq: (value) =>
          eq(
            auditLog.action,
            value === 'success'
              ? SIGN_IN_ACTIONS.succeeded
              : SIGN_IN_ACTIONS.failed,
          ),
      },
    },
    ip: { column: auditLog.ip, type: 'string', ops: ['eq'] },
    at: {
      column: auditLog.at,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    },
  },
  {
    select: [
      'id',
      'at',
      'user',
      'userLabel',
      'userName',
      'result',
      'method',
      'via',
      'userAgent',
      'ip',
    ],
  },
);
