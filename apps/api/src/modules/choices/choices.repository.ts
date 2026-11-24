import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, ilike } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { escapeLike } from '../../core/http/list-query.js';
import { users } from '../../iam/auth/auth.tables.js';
import { currentMembership } from '../../iam/organization/memberships.js';
import {
  organizationalUnitMemberships,
  organizationalUnits,
} from '../../iam/organization/organization.tables.js';
import type { ChoiceItem } from './choices.registry.js';

/** What to narrow a list of options to: a name's part, or one value. */
export type ChoiceFilter = { q?: string; value?: string };

/**
 * The built-in providers' queries (choices.builtins.ts), read through the
 * request's transaction, behind row-level security.
 */
@Injectable()
export class ChoicesRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async units(
    { q, value }: ChoiceFilter,
    limit: number,
  ): Promise<ChoiceItem[]> {
    return this.db
      .select({
        value: organizationalUnits.id,
        label: organizationalUnits.name,
      })
      .from(organizationalUnits)
      .where(
        and(
          q ? ilike(organizationalUnits.name, `%${escapeLike(q)}%`) : undefined,
          value === undefined ? undefined : eq(organizationalUnits.id, value),
        ),
      )
      .orderBy(asc(organizationalUnits.name), asc(organizationalUnits.id))
      .limit(limit);
  }

  /** The unit's current members. */
  async unitMembers(
    unitId: string,
    { q, value }: ChoiceFilter,
    limit: number,
  ): Promise<ChoiceItem[]> {
    return this.db
      .select({ value: users.id, label: users.name })
      .from(organizationalUnitMemberships)
      .innerJoin(users, eq(users.id, organizationalUnitMemberships.userId))
      .where(
        and(
          eq(organizationalUnitMemberships.unitId, unitId),
          currentMembership(),
          q ? ilike(users.name, `%${escapeLike(q)}%`) : undefined,
          value === undefined ? undefined : eq(users.id, value),
        ),
      )
      .orderBy(asc(users.name), asc(users.id))
      .limit(limit);
  }
}
