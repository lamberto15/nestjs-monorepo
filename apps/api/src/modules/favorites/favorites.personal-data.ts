import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { FavoritesRepository } from './favorites.repository.js';

/** The person's favorites, in their order: in their export, deleted with their account. */
@PersonalData({ name: 'favorites', scopes: ['tenant'] })
@Injectable()
export class FavoritesPersonalData implements PersonalDataSection {
  constructor(private readonly repository: FavoritesRepository) {}

  async rows({ key }: PersonalDataSubject) {
    return this.repository.ofOwner(key);
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.deleteOfOwner(key);
  }
}
