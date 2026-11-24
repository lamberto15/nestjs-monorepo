import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { RevisionsRepository } from './revisions.repository.js';

/** Who made a change once its person is gone. */
const ANONYMIZED = 'anonymized';

/**
 * Revisions are the records' history, not the person's data: nothing to
 * export. At the deletion they stay, their author becomes `anonymized`.
 */
@PersonalData({ name: 'revisions', scopes: ['tenant'] })
@Injectable()
export class RevisionsPersonalData implements PersonalDataSection {
  constructor(private readonly repository: RevisionsRepository) {}

  async erase({ key }: PersonalDataSubject) {
    await this.repository.renameChanger(key, ANONYMIZED);
  }
}
