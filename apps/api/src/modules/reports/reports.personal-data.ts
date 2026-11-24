import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { ReportsRepository } from './reports.repository.js';

/** The person's report schedules: in their export, deleted with their account (the addresses they mail are theirs to give). */
@PersonalData({ name: 'reports', scopes: ['tenant'] })
@Injectable()
export class ReportsPersonalData implements PersonalDataSection {
  constructor(private readonly repository: ReportsRepository) {}

  async rows({ key }: PersonalDataSubject) {
    return this.repository.ownedBy(key);
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.deleteOwnedBy(key);
  }
}
