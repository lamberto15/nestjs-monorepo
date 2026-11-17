import {
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  AccessRecordFinder,
  type RecordFinder,
} from '../../iam/access/access-record-finder.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import type { PresenceRecord } from './presence.schemas.js';

/**
 * Who may be on a record: whoever may read it. The record is found as the
 * caller, by the provider its module marked `@AccessRecordFinder('Note')`
 * (iam/access: the same one the access explanation uses), so a record the
 * caller may not read, a subject without a finder and a missing id are all
 * the same 404 (it never says which).
 */
@Injectable()
export class PresenceRecords implements OnModuleInit {
  private readonly finders = new Map<string, RecordFinder>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly access: AccessService,
  ) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders({
      metadataKey: AccessRecordFinder.KEY,
    })) {
      const subject = this.discovery.getMetadataByDecorator(
        AccessRecordFinder,
        wrapper,
      );
      if (subject && wrapper.instance) {
        this.finders.set(subject, wrapper.instance as RecordFinder);
      }
    }
  }

  async assertReads(user: RequestPrincipal, record: PresenceRecord) {
    const row = await this.finders
      .get(record.subject)
      ?.find(record.recordId, user);
    if (!row || !(await this.access.can(user, 'read', record.subject, row))) {
      throw new NotFoundException({
        code: 'not_found',
        message: 'No such record, or you may not see it.',
      });
    }
  }
}
