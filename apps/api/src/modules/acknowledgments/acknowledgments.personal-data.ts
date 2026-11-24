import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { AcknowledgmentsRepository } from './acknowledgments.repository.js';

/** The acknowledgments asked of the person: in their export, deleted with their account (the audit log keeps the answers, by key). */
@PersonalData({ name: 'acknowledgments', scopes: ['tenant'] })
@Injectable()
export class AcknowledgmentsPersonalData implements PersonalDataSection {
  constructor(private readonly repository: AcknowledgmentsRepository) {}

  async rows({ key }: PersonalDataSubject) {
    return this.repository.ofPerson(key);
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.deleteOfPerson(key);
  }
}
