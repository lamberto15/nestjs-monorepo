import { type AnyColumn, ilike, or, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { escapeLike, listQuery } from '../../core/http/list-query.js';
import { memberships, users } from '../auth/auth.tables.js';

/**
 * What GET /access/users can be filtered, sorted and narrowed by. `unitId`
 * (a unit's current members, not those of the units below) is the unit
 * directory's to answer: `members` builds that condition (MembersService
 * passes the organization module's; the schema needs none).
 */
export const userList = (
  members: (userId: AnyPgColumn, unitIds: readonly string[]) => SQL,
) =>
  listQuery(
    {
      email: {
        column: users.email,
        type: 'string',
        ops: ['eq', 'contains', 'startsWith', 'endsWith'],
        sortable: true,
      },
      name: {
        column: users.name,
        type: 'string',
        ops: ['contains', 'startsWith'],
        sortable: true,
      },
      // The membership in this tenant.
      active: { column: memberships.active, type: 'boolean', ops: ['eq'] },
      emailVerified: {
        column: users.emailVerified,
        type: 'boolean',
        ops: ['eq'],
      },
      unitId: {
        column: users.id,
        type: 'uuid',
        ops: ['eq', 'in'],
        ref: 'unit',
        conditions: {
          eq: (value) => members(users.id, [value as string]),
          in: (value) => members(users.id, value as string[]),
        },
      },
      createdAt: {
        column: users.createdAt,
        type: 'datetime',
        ops: ['gt', 'gte', 'lt', 'lte', 'between'],
        sortable: true,
      },
      updatedAt: {
        column: users.updatedAt,
        type: 'datetime',
        ops: ['gt', 'gte', 'lt', 'lte', 'between'],
        sortable: true,
      },
    },
    {
      select: [
        'id',
        'kind',
        'email',
        'name',
        'emailVerified',
        'locale',
        'timezone',
        'active',
        'hasPassword',
        'createdAt',
        'updatedAt',
        'roleIds',
        'roles',
        'unitIds',
      ],
    },
  );

/** Without a unit directory nobody is in a unit. */
export const NO_MEMBERS = () => sql`false`;

/** The list as the route validates it: the unit condition is MembersService's. */
export const USER_LIST = userList(NO_MEMBERS);

/** The union's alias: the list's fields name its columns. */
const PRINCIPALS = sql.identifier('principals');
const column = (name: string) => sql`${PRINCIPALS}.${sql.identifier(name)}`;
const label = column('label');
const email = column('email');
/** The union's id, for the cursor and the order (a uuid: users' and clients' never meet). */
export const PRINCIPALS_ID = column('id') as unknown as AnyColumn;

/**
 * What GET /access/principals can be searched, filtered and sorted by: the
 * tenant's members and API clients as one list. `q` matches a part of the
 * name or of the address, whatever the case, its `%` and `_` as the
 * characters.
 */
export const PRINCIPAL_LIST = listQuery(
  {
    q: {
      column: label,
      type: 'string',
      ops: ['eq'],
      conditions: {
        eq: (value) => {
          const pattern = `%${escapeLike(value as string)}%`;
          return or(ilike(label, pattern), ilike(email, pattern))!;
        },
      },
    },
    kind: {
      column: column('kind'),
      type: 'enum',
      values: ['user', 'client'],
      ops: ['eq'],
    },
    active: { column: column('active'), type: 'boolean', ops: ['eq'] },
    label: {
      column: label,
      type: 'string',
      ops: ['contains', 'startsWith'],
      sortable: true,
      // Whatever the case; its own key in the rows, so `label` stays as it is.
      sort: sql`lower(${label})`,
    },
  },
  { select: ['id', 'key', 'kind', 'label', 'email', 'active'] },
);
