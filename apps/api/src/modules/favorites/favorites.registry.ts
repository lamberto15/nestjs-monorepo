import { Injectable } from '@nestjs/common';

/** The subjects whose records can be pinned: each `FavoritesModule.forRecord()` adds its record's. */
@Injectable()
export class FavoritesRegistry {
  private readonly known = new Set<string>();

  add(subject: string) {
    this.known.add(subject);
  }

  has(subject: string) {
    return this.known.has(subject);
  }
}
