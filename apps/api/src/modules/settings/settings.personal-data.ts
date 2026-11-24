import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { SettingsRepository } from './settings.repository.js';

/** The settings the person set for themselves: in their export, deleted with their account. */
@PersonalData({ name: 'settings', scopes: ['tenant'] })
@Injectable()
export class SettingsPersonalData implements PersonalDataSection {
  constructor(private readonly repository: SettingsRepository) {}

  async rows({ key }: PersonalDataSubject) {
    return this.repository.ownValuesOf(key);
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.deleteOwnValuesOf(key);
  }
}
