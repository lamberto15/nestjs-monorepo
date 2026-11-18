import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, ilike } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { escapeLike } from '../../core/http/list-query.js';
import { AccessService } from '../../iam/access/access.service.js';
import { users } from '../../iam/auth/auth.tables.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { currentMembership } from '../../iam/organization/memberships.js';
import { OrganizationService } from '../../iam/organization/organization.service.js';
import {
  organizationalUnitMemberships,
  organizationalUnits,
} from '../../iam/organization/organization.tables.js';
import {
  type ChoiceItem,
  type ChoiceProvider,
  ChoiceSource,
  type ChoiceSet,
  paramFits,
} from './choices.registry.js';

/** The set the module ships with, as its example: pick a unit, then one of its members. */
export const UNIT_MEMBER_SET: ChoiceSet = {
  key: 'unit-member',
  label: 'A unit, then one of its members',
  fields: {
    unit: { provider: 'organizational-units' },
    member: { provider: 'unit-members', params: { unitId: 'unit' } },
  },
};

/**
 * The tenant's units, as every user may see them. Read through the
 * request's transaction, behind row-level security, so a tenant never sees
 * another's rows.
 */
@ChoiceSource()
@Injectable()
export class OrganizationalUnitsChoices implements ChoiceProvider {
  readonly key = 'organizational-units';
  readonly label = 'Organizational units';
  readonly params = {};

  constructor(@InjectTransaction() private readonly db: Database) {}

  async mayUse(principal: RequestPrincipal) {
    return principal.kind === 'user';
  }

  options({ q, limit }: { q: string | undefined; limit: number }) {
    return this.find(
      q ? ilike(organizationalUnits.name, `%${escapeLike(q)}%`) : undefined,
      limit,
    );
  }

  async has({ value }: { value: string }) {
    return (
      paramFits('uuid', value) &&
      (await this.find(eq(organizationalUnits.id, value), 1)).length > 0
    );
  }

  private find(
    where: ReturnType<typeof and>,
    limit: number,
  ): Promise<ChoiceItem[]> {
    return this.db
      .select({
        value: organizationalUnits.id,
        label: organizationalUnits.name,
      })
      .from(organizationalUnits)
      .where(where)
      .orderBy(asc(organizationalUnits.name), asc(organizationalUnits.id))
      .limit(limit);
  }
}

/**
 * The current members of a unit, by name. Seen by whoever manages users
 * and by the unit's own members; for anyone else the unit has no members
 * to choose from (an empty answer, as for a unit that does not exist, so
 * it never says which units have whom).
 */
@ChoiceSource()
@Injectable()
export class UnitMembersChoices implements ChoiceProvider {
  readonly key = 'unit-members';
  readonly label = 'Members of an organizational unit';
  readonly params = { unitId: 'uuid' } as const;

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly access: AccessService,
    private readonly organization: OrganizationService,
  ) {}

  async mayUse(principal: RequestPrincipal) {
    return principal.kind === 'user';
  }

  async options({
    principal,
    params,
    q,
    limit,
  }: {
    principal: RequestPrincipal;
    params: Record<string, string>;
    q: string | undefined;
    limit: number;
  }) {
    return (await this.may(principal, params.unitId!))
      ? this.find(
          params.unitId!,
          limit,
          q ? ilike(users.name, `%${escapeLike(q)}%`) : undefined,
        )
      : [];
  }

  async has({
    principal,
    params,
    value,
  }: {
    principal: RequestPrincipal;
    params: Record<string, string>;
    value: string;
  }) {
    return (
      paramFits('uuid', value) &&
      (await this.may(principal, params.unitId!)) &&
      (await this.find(params.unitId!, 1, eq(users.id, value))).length > 0
    );
  }

  private async may(principal: RequestPrincipal, unitId: string) {
    return (
      principal.kind === 'user' &&
      ((await this.access.can(principal, 'manageUsers', 'Access')) ||
        (await this.organization.unitsOf(principal.id)).includes(unitId))
    );
  }

  private find(
    unitId: string,
    limit: number,
    extra?: ReturnType<typeof and>,
  ): Promise<ChoiceItem[]> {
    return this.db
      .select({ value: users.id, label: users.name })
      .from(organizationalUnitMemberships)
      .innerJoin(users, eq(users.id, organizationalUnitMemberships.userId))
      .where(
        and(
          eq(organizationalUnitMemberships.unitId, unitId),
          currentMembership(),
          extra,
        ),
      )
      .orderBy(asc(users.name), asc(users.id))
      .limit(limit);
  }
}
