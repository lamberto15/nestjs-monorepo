import { Injectable } from '@nestjs/common';

/** The subjects whose opened records are noted: each `RecentsModule.forRecord()` adds its record's. */
@Injectable()
export class RecentsRegistry {
  private readonly known = new Set<string>();

  add(subject: string) {
    this.known.add(subject);
  }

  has(subject: string) {
    return this.known.has(subject);
  }
}
