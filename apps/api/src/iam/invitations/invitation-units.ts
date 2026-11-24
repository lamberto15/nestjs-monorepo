import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AccessService } from '../access/access.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { OrganizationService } from '../organization/organization.service.js';
import { InvitationsRepository } from './invitations.repository.js';

/**
 * What an invitation does with organizational units: checks the ones it
 * names, and places the new member in them when it is accepted (an
 * invitation has no acting user then, so OrganizationService.addMember,
 * which asks authority over a member, is not the way).
 */
@Injectable()
export class InvitationUnits {
  constructor(
    private readonly repository: InvitationsRepository,
    private readonly access: AccessService,
    private readonly organization: OrganizationService,
  ) {}

  /** Those of `ids` that are this tenant's units now. */
  async existing(ids: readonly string[]) {
    if (!ids.length) return [];
    return this.repository.existingUnitIds([...new Set(ids)]);
  }

  /** 400 for an id that isn't one of the tenant's units. */
  async assertExist(ids: readonly string[]) {
    if ((await this.existing(ids)).length !== new Set(ids).size) {
      throw new BadRequestException('Unknown organizational unit.');
    }
  }

  /**
   * Whoever places people in a unit needs authority over it:
   * `manageOrganizationalUnits`, or a current membership of it or of a
   * unit above it. Otherwise an invitation could put someone in a unit and
   * show them, under "my units and below", what the inviter can't.
   */
  async assertAuthority(actor: UserPrincipal, ids: readonly string[]) {
    if (!ids.length) return;
    if (await this.access.can(actor, 'manageOrganizationalUnits', 'Access')) {
      return;
    }
    const mine = await this.organization.unitsOf(actor.id, { below: true });
    if (ids.some((id) => !mine.includes(id))) {
      throw new ForbiddenException({
        code: 'unit_authority_required',
        message:
          'You can’t place people in a unit you neither manage nor belong to (or one above it).',
      });
    }
  }

  /** The user becomes a member of each of these units still there, unless already one. */
  async place(userId: string, ids: readonly string[]) {
    const units = await this.existing(ids);
    if (!units.length) return;
    const open = await this.repository.openUnitIds(userId, units);
    const joined = units.filter((unitId) => !open.includes(unitId));
    if (joined.length) {
      // Dated by the app's clock, as every other writer of memberships and
      // every `currentMembership()` reader is: the column's default is the
      // database's clock, and one running ahead of the app's would leave
      // the new member out of their units until it caught up.
      const validFrom = new Date();
      await this.repository.insertUnitMemberships(userId, joined, validFrom);
    }
  }
}
