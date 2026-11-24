import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { DocumentsRepository } from './documents.repository.js';

/** Who a document is asked by once its person is gone. */
const ANONYMIZED = 'anonymized';

/**
 * The documents the person asked for: in their export (without the run's
 * secret). At the deletion they stay with their records, asked for by nobody.
 */
@PersonalData({ name: 'documents', scopes: ['tenant'] })
@Injectable()
export class DocumentsPersonalData implements PersonalDataSection {
  constructor(private readonly repository: DocumentsRepository) {}

  async *rows({ key }: PersonalDataSubject) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.repository.ofRequester(key, cursor, 1000);
      if (rows.length === 0) return;
      yield rows.map(({ runToken: _token, ...row }) => row);
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.renameRequester(key, ANONYMIZED);
  }
}
