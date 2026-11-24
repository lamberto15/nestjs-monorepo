import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { RecentsRepository } from './recents.repository.js';

/** The person's recently viewed records: in their export, deleted with their account. */
@PersonalData({ name: 'recents', scopes: ['tenant'] })
@Injectable()
export class RecentsPersonalData implements PersonalDataSection {
  constructor(private readonly repository: RecentsRepository) {}

  async rows({ key }: PersonalDataSubject) {
    return this.repository.allOf(key);
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.deleteAllOf(key);
  }
}
