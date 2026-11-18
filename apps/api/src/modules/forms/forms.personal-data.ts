import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import {
  submissionColumns,
  submissionView,
} from './form-submissions.service.js';
import { formSubmissions, formVersions } from './forms.tables.js';

/**
 * A person's submissions: in their data export, and gone with their
 * account, since answers may say anything about them.
 */
@PersonalData({ name: 'form-submissions', scopes: ['tenant'] })
@Injectable()
export class FormSubmissionsPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ key }: PersonalDataSubject) {
    const rows = await this.db
      .select(submissionColumns)
      .from(formSubmissions)
      .innerJoin(formVersions, eq(formVersions.id, formSubmissions.versionId))
      .where(eq(formSubmissions.submittedBy, key));
    return rows.map(submissionView);
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db
      .delete(formSubmissions)
      .where(eq(formSubmissions.submittedBy, key));
  }
}
