import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { ViewsRepository } from './views.repository.js';

/**
 * The saved views the person owns: in their export. At the deletion the private
 * ones go; shared ones stay for the unit or tenant, ownerless (`anonymous`),
 * changeable by whoever manages them.
 */
@PersonalData({ name: 'views', scopes: ['tenant'] })
@Injectable()
export class ViewsPersonalData implements PersonalDataSection {
  constructor(private readonly repository: ViewsRepository) {}

  async rows({ key }: PersonalDataSubject) {
    return this.repository.ownedBy(key);
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.eraseOwner(key, 'anonymous');
  }
}
