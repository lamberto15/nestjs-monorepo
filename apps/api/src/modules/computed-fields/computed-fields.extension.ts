import { Inject, Injectable } from '@nestjs/common';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { RecordDeclaration } from '../records/record.js';
import {
  InjectRecord,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import {
  type ComputedDeclaration,
  hideComputed,
  withComputed,
} from './computed-fields.js';

/** The computed fields a ComputedFieldsModule.forRecord() works with. */
export const COMPUTED = Symbol('COMPUTED');

/**
 * What computed fields add to a record: each one on every record shown
 * (`fields=` may pick them), computed from the record as the API shows
 * it, less those that read a field its reader may not see on that record.
 * They depend only on the row, so they are in the ETag.
 */
@RecordExtension()
@Injectable()
export class ComputedFieldsExtension implements RecordHooks {
  readonly shows: readonly string[];

  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    @Inject(COMPUTED) private readonly computed: ComputedDeclaration,
    private readonly access: AccessService,
  ) {
    this.shows = Object.keys(computed.fields);
  }

  async present(principal: Principal, views: Record<string, unknown>[]) {
    const shown = withComputed(this.computed, views);
    // The presenter redacts after the add-ons: ask what it will take out of each.
    return Promise.all(
      shown.map(async (view, index) => {
        const redacted = await this.access.redact(
          principal,
          'read',
          this.record.subject,
          views[index]!,
        );
        const hidden = Object.keys(views[index]!).filter(
          (key) => !(key in redacted),
        );
        return hideComputed(this.computed, view, hidden);
      }),
    );
  }
}
