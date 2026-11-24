import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from './personal-data.js';
import { PersonalDataRepository } from './personal-data.repository.js';

/**
 * The roles the person holds in each tenant, for their export. Nothing to
 * erase: the grants go with their memberships at the deletion.
 */
@PersonalData({ name: 'roles', scopes: ['tenant'] })
@Injectable()
export class RolesSection implements PersonalDataSection {
  constructor(private readonly repository: PersonalDataRepository) {}

  async rows({ userId }: PersonalDataSubject) {
    return this.repository.rolesOf(userId);
  }
}

/**
 * The organizational units the person belongs to in each tenant, for their
 * export. Nothing to erase: the memberships go with the account's.
 */
@PersonalData({ name: 'organizational-units', scopes: ['tenant'] })
@Injectable()
export class UnitsSection implements PersonalDataSection {
  constructor(private readonly repository: PersonalDataRepository) {}

  async rows({ userId }: PersonalDataSubject) {
    return this.repository.unitsOf(userId);
  }
}
