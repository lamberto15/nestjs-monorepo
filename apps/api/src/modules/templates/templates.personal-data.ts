import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { TemplatesRepository } from './templates.repository.js';

/**
 * The record templates the person owns: in their export. At the deletion the private
 * ones go; shared ones stay for the unit or tenant, ownerless (`anonymous`),
 * changeable by whoever manages them.
 */
@PersonalData({ name: 'templates', scopes: ['tenant'] })
@Injectable()
export class TemplatesPersonalData implements PersonalDataSection {
  constructor(private readonly repository: TemplatesRepository) {}

  async rows({ key }: PersonalDataSubject) {
    return this.repository.ownedBy(key);
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.eraseOwner(key, 'anonymous');
  }
}
