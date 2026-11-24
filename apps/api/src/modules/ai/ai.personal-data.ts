import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { AiRepository } from './ai.repository.js';

/** Who a run is asked by once its person is gone. */
const ANONYMIZED = 'anonymized';

/**
 * The person's AI runs (no prompts, no outputs are stored): in their export.
 * At the deletion the usage stays (it counts toward the quota), asked for by
 * nobody.
 */
@PersonalData({ name: 'ai', scopes: ['tenant'] })
@Injectable()
export class AiPersonalData implements PersonalDataSection {
  constructor(private readonly repository: AiRepository) {}

  async *rows({ key }: PersonalDataSubject) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.repository.ofRequester(key, cursor, 1000);
      if (rows.length === 0) return;
      yield rows;
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.renameRequester(key, ANONYMIZED);
  }
}
