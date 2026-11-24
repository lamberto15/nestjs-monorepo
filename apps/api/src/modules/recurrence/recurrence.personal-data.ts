import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { RecurrenceRepository } from './recurrence.repository.js';

/** The person's record schedules: in their export, deleted with their account (what they would create is theirs to give). */
@PersonalData({ name: 'record-schedules', scopes: ['tenant'] })
@Injectable()
export class RecurrencePersonalData implements PersonalDataSection {
  constructor(private readonly repository: RecurrenceRepository) {}

  async rows({ key }: PersonalDataSubject) {
    return this.repository.ownedBy(key);
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.deleteOwnedBy(key);
  }
}
