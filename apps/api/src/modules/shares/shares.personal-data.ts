import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { SharesRepository } from './shares.repository.js';

/** Who a link was made by once its person is gone. */
const ANONYMIZED = 'anonymous';

/**
 * The links the person made (not their secrets): in their export. At the
 * deletion the working ones are revoked and every one loses their name.
 */
@PersonalData({ name: 'shares', scopes: ['tenant'] })
@Injectable()
export class SharesPersonalData implements PersonalDataSection {
  constructor(private readonly repository: SharesRepository) {}

  async rows({ key }: PersonalDataSubject) {
    return this.repository.madeBy(key);
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.anonymize(key, ANONYMIZED);
  }
}
