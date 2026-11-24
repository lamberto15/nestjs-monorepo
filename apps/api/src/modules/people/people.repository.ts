import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, max } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { escapeLike } from '../../core/http/list-query.js';
import { afterCursor } from '../../core/http/pagination.js';
import { apiClients, memberships, users } from '../../iam/auth/auth.tables.js';
import {
  organizationalUnitClosure,
  organizationalUnits,
} from '../../iam/organization/organization.tables.js';
import type { UnitsQuery } from './people.schemas.js';

/**
 * The people's queries, in the caller's transaction (`@InjectTransaction()`).
 * Users are global: each query of them is held to the tenant's memberships,
 * the tenant said by the caller. API clients and units are tenant rows
 * behind row-level security.
 */
@Injectable()
export class PeopleRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** The users among `ids` whose address is one of `emails`. */
  usersByEmail(ids: string[], emails: string[]) {
    return this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(inArray(users.id, ids), inArray(users.email, emails)));
  }

  /** The names of the users among `ids` who are or were members of the tenant. */
  memberNames(ids: string[], tenantId: string) {
    return this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, users.id),
          eq(memberships.tenantId, tenantId),
        ),
      )
      .where(inArray(users.id, ids));
  }

  clientNames(ids: string[]) {
    return this.db
      .select({ id: apiClients.id, name: apiClients.name })
      .from(apiClients)
      .where(inArray(apiClients.id, ids));
  }

  /** The tenant's active members whose name contains `q`, by name. */
  activeMembers(tenantId: string, q: string | undefined, limit: number) {
    return this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, users.id),
          eq(memberships.tenantId, tenantId),
          eq(memberships.active, true),
        ),
      )
      .where(
        and(
          eq(users.active, true),
          q ? ilike(users.name, `%${escapeLike(q)}%`) : undefined,
        ),
      )
      .orderBy(asc(users.name), asc(users.id))
      .limit(limit);
  }

  /** A page of units, newest first, one more than the limit. */
  units(query: UnitsQuery) {
    return this.db
      .select({
        id: organizationalUnits.id,
        type: organizationalUnits.type,
        name: organizationalUnits.name,
        parentId: organizationalUnits.parentId,
      })
      .from(organizationalUnits)
      .where(
        and(
          query.q
            ? ilike(organizationalUnits.name, `%${escapeLike(query.q)}%`)
            : undefined,
          query.id ? inArray(organizationalUnits.id, query.id) : undefined,
          afterCursor(organizationalUnits.id, query),
        ),
      )
      .orderBy(desc(organizationalUnits.id))
      .limit(query.limit + 1);
  }

  /** Each unit's depth in the tree. */
  depths(ids: string[]) {
    return this.db
      .select({
        id: organizationalUnitClosure.descendantId,
        depth: max(organizationalUnitClosure.depth),
      })
      .from(organizationalUnitClosure)
      .where(inArray(organizationalUnitClosure.descendantId, ids))
      .groupBy(organizationalUnitClosure.descendantId);
  }

  async findClient(id: string) {
    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.id, id));
    return client;
  }
}
