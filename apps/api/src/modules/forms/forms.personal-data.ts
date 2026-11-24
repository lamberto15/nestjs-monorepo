import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { submissionView } from './form-submissions.service.js';
import { FormsRepository } from './forms.repository.js';

/**
 * A person's submissions: in their data export, and gone with their
 * account, since answers may say anything about them.
 */
@PersonalData({ name: 'form-submissions', scopes: ['tenant'] })
@Injectable()
export class FormSubmissionsPersonalData implements PersonalDataSection {
  constructor(private readonly repository: FormsRepository) {}

  async rows({ key }: PersonalDataSubject) {
    return (await this.repository.submissionsOf(key)).map(submissionView);
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.deleteSubmissionsOf(key);
  }
}
