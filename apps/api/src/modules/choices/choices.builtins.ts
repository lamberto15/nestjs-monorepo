import { Injectable } from '@nestjs/common';
import { AccessService } from '../../iam/access/access.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { OrganizationService } from '../../iam/organization/organization.service.js';
import {
  type ChoiceProvider,
  ChoiceSource,
  type ChoiceSet,
  paramFits,
} from './choices.registry.js';
import { ChoicesRepository } from './choices.repository.js';

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

  constructor(private readonly repository: ChoicesRepository) {}

  async mayUse(principal: RequestPrincipal) {
    return principal.kind === 'user';
  }

  options({ q, limit }: { q: string | undefined; limit: number }) {
    return this.repository.units({ q }, limit);
  }

  async has({ value }: { value: string }) {
    return (
      paramFits('uuid', value) &&
      (await this.repository.units({ value }, 1)).length > 0
    );
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
    private readonly repository: ChoicesRepository,
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
      ? this.repository.unitMembers(params.unitId!, { q }, limit)
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
      (await this.repository.unitMembers(params.unitId!, { value }, 1)).length >
        0
    );
  }

  private async may(principal: RequestPrincipal, unitId: string) {
    return (
      principal.kind === 'user' &&
      ((await this.access.can(principal, 'manageUsers', 'Access')) ||
        (await this.organization.unitsOf(principal.id)).includes(unitId))
    );
  }
}
