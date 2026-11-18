import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { roles, userRoles } from '../access/access.tables.js';
import {
  organizationalUnitMemberships,
  organizationalUnits,
} from '../organization/organization.tables.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from './personal-data.js';

/**
 * The roles the person holds in each tenant, for their export. Nothing to
 * erase: the grants go with their memberships at the deletion.
 */
@PersonalData({ name: 'roles', scopes: ['tenant'] })
@Injectable()
export class RolesSection implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ userId }: PersonalDataSubject) {
    return this.db
      .select({
        id: roles.id,
        key: roles.key,
        name: roles.name,
        expiresAt: userRoles.expiresAt,
      })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId));
  }
}

/**
 * The organizational units the person belongs to in each tenant, for their
 * export. Nothing to erase: the memberships go with the account's.
 */
@PersonalData({ name: 'organizational-units', scopes: ['tenant'] })
@Injectable()
export class UnitsSection implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ userId }: PersonalDataSubject) {
    return this.db
      .select({
        id: organizationalUnits.id,
        name: organizationalUnits.name,
        role: organizationalUnitMemberships.role,
        validFrom: organizationalUnitMemberships.validFrom,
        validTo: organizationalUnitMemberships.validTo,
      })
      .from(organizationalUnitMemberships)
      .innerJoin(
        organizationalUnits,
        eq(organizationalUnits.id, organizationalUnitMemberships.unitId),
      )
      .where(eq(organizationalUnitMemberships.userId, userId));
  }
}
