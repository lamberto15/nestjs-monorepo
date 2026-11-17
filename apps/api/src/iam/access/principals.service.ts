import { InjectTransaction } from '@nestjs-cls/transactional';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countMatching,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { authConfig } from '../auth/auth.config.js';
import { apiClients, memberships, users } from '../auth/auth.tables.js';
import { PRINCIPAL_LIST, PRINCIPALS_ID } from './access.lists.js';

/** A user or an API client, as a picker shows it. */
export interface PrincipalView {
  id: string;
  /** The principal's key, as settings' overrides and `actor` filters take it. */
  key: string;
  kind: 'user' | 'client';
  /** The user's name, or the client's. */
  label: string;
  /** A user's address; null for a client. */
  email: string | null;
  /** The membership in this tenant and the account (a user), or the client. */
  active: boolean;
}

/**
 * The principals of the current tenant: its members (through their
 * memberships, as GET /access/users) and its API clients (row-level
 * security), one page of both. Nothing more of them than the two lists
 * show the same callers.
 */
@Injectable()
export class PrincipalsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly tenancy: Tenancy,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
  ) {}

  async page(query: ListQuery) {
    const tenantId = this.tenancy.tenantId();
    const members = this.db
      .select({
        id: users.id,
        kind: sql<'user' | 'client'>`'user'`.as('kind'),
        // Named as the list's fields read them (a column keeps its own name).
        label: sql<string>`${users.name}`.as('label'),
        email: sql<string | null>`${users.email}`.as('email'),
        active: sql<boolean>`(${users.active} and ${memberships.active})`.as(
          'active',
        ),
      })
      .from(users)
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, users.id),
          eq(memberships.tenantId, tenantId),
        ),
      );
    // API_CLIENTS=off: no client shows here either.
    const principals = (
      this.auth.apiClients
        ? members.unionAll(
            this.db
              .select({
                id: apiClients.id,
                kind: sql<'user' | 'client'>`'client'`.as('kind'),
                label: sql<string>`${apiClients.name}`.as('label'),
                email: sql<string | null>`null::text`.as('email'),
                active: sql<boolean>`${apiClients.active}`.as('active'),
              })
              .from(apiClients),
          )
        : members
    ).as('principals');
    const where = PRINCIPAL_LIST.where(query);
    const [rows, total] = await Promise.all([
      this.db
        .select({
          id: principals.id,
          kind: principals.kind,
          label: principals.label,
          email: principals.email,
          active: principals.active,
          ...PRINCIPAL_LIST.sortSelect(query),
        })
        .from(principals)
        .where(and(where, afterCursor(PRINCIPALS_ID, query)))
        .orderBy(...pageOrder(PRINCIPALS_ID, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countMatching(
        this.db,
        this.db
          .select({ one: sql`1` })
          .from(principals)
          .where(where),
        query,
      ),
    ]);
    const page = toPage(rows, query, total);
    return {
      ...page,
      items: page.items.map((row): PrincipalView => ({
        ...row,
        key: `${row.kind}:${row.id}`,
      })),
    };
  }
}
