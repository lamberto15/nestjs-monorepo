import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { favorites } from './favorites.tables.js';

/** The person's favorites, in their order: in their export, deleted with their account. */
@PersonalData({ name: 'favorites', scopes: ['tenant'] })
@Injectable()
export class FavoritesPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ key }: PersonalDataSubject) {
    return this.db
      .select()
      .from(favorites)
      .where(eq(favorites.owner, key))
      .orderBy(favorites.position);
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db.delete(favorites).where(eq(favorites.owner, key));
  }
}
