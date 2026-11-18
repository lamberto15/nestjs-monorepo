import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { RecordDeclaration } from '../records/record.js';

/**
 * A record that takes the AI helper (`AiModule.forRecord(NOTE)`), found by
 * discovery. Its name in a request is the record's collection path.
 */
export class AiSourceRegistration {
  constructor(readonly record: RecordDeclaration) {}

  /** Nest hashes a dynamic module's metadata: the subject names the record. */
  toJSON() {
    return `ai-source:${this.record.subject}`;
  }
}

/** The records that take the helper, by the name a request gives (their path). */
@Injectable()
export class AiSources implements OnModuleInit {
  private readonly sources = new Map<string, RecordDeclaration>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders()) {
      const found: unknown = wrapper.instance;
      if (found instanceof AiSourceRegistration) {
        this.sources.set(found.record.path, found.record);
      }
    }
  }

  get(name: string) {
    return this.sources.get(name);
  }
}
