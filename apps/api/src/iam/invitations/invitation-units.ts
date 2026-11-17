import { InjectTransaction } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { AccessService } from '../access/access.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { OrganizationService } from '../organization/organization.service.js';
import {
  organizationalUnitMemberships,
  organizationalUnits,
} from '../organization/organization.tables.js';

/**
 * What an invitation does with organizational units: checks the ones it
 * names, and places the new member in them when it is accepted (an
 * invitation has no acting user then, so OrganizationService.addMember,
 * which asks authority over a member, is not the way).
 */
@Injectable()
export class InvitationUnits {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly access: AccessService,
    private readonly organization: OrganizationService,
  ) {}

  /** Those of `ids` that are this tenant's units now. */
  async existing(ids: readonly string[]) {
    if (!ids.length) return [];
    const found = await this.db
      .select({ id: organizationalUnits.id })
      .from(organizationalUnits)
      .where(inArray(organizationalUnits.id, [...new Set(ids)]));
    return found.map((row) => row.id);
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
    const open = await this.db
      .select({ unitId: organizationalUnitMemberships.unitId })
      .from(organizationalUnitMemberships)
      .where(
        and(
          eq(organizationalUnitMemberships.userId, userId),
          inArray(organizationalUnitMemberships.unitId, units),
          isNull(organizationalUnitMemberships.validTo),
        ),
      );
    const joined = units.filter(
      (unitId) => !open.some((row) => row.unitId === unitId),
    );
    if (joined.length) {
      await this.db
        .insert(organizationalUnitMemberships)
        .values(joined.map((unitId) => ({ unitId, userId })));
    }
  }
}
