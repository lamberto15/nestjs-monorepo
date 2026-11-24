import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { publicRenditions } from './attachments.renditions.js';
import { AttachmentsRepository } from './attachments.repository.js';

/** Who a file is uploaded by once its person is gone. */
const ANONYMIZED = 'anonymized';

/**
 * The files the person uploaded: their rows in the export, not the files.
 * At the deletion the files stay with their records, uploaded by nobody.
 */
@PersonalData({ name: 'attachments', scopes: ['tenant'] })
@Injectable()
export class AttachmentsPersonalData implements PersonalDataSection {
  constructor(private readonly repository: AttachmentsRepository) {}

  async *rows({ key }: PersonalDataSubject) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.repository.uploadedBy(key, cursor, 1000);
      if (rows.length === 0) return;
      yield rows.map(({ key: _file, renditions, ...row }) => ({
        ...row,
        renditions: publicRenditions(renditions),
      }));
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.renameUploader(key, ANONYMIZED);
  }
}
