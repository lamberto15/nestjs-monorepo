import { Injectable } from '@nestjs/common';

/** The subjects whose records take tags: each `TagsModule.forRecord()` adds its record's. */
@Injectable()
export class TagsRegistry {
  private readonly known = new Set<string>();

  add(subject: string) {
    this.known.add(subject);
  }

  has(subject: string) {
    return this.known.has(subject);
  }

  subjects() {
    return [...this.known];
  }
}
