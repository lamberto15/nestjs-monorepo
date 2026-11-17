import { Inject, Injectable } from '@nestjs/common';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { RecordDeclaration } from './record.js';
import { RECORD } from './record-extension.js';

/**
 * A record's policy (@nestjs/authorization): each standard action checked
 * by AccessService against the row as stored, so the conditions
 * recordPermissions() declared (`mine`, the units', the recycle bin's
 * `deletedAt`, which refuses all but restore) decide. The feature's policy
 * extends it; an ability of its own overrides one or adds one.
 *
 * ```ts
 * @Policy()
 * export class InvoicePolicy extends RecordPolicy {}
 * ```
 */
@Injectable()
export abstract class RecordPolicy {
  constructor(
    protected readonly access: AccessService,
    @Inject(RECORD) protected readonly record: RecordDeclaration,
  ) {}

  create(user: Principal | null) {
    return this.access.can(user, 'create', this.record.subject);
  }

  read(user: Principal | null, row?: Record<string, unknown>) {
    return this.access.can(user, 'read', this.record.subject, row);
  }

  update(user: Principal | null, row?: Record<string, unknown>) {
    return this.access.can(user, 'update', this.record.subject, row);
  }

  delete(user: Principal | null, row?: Record<string, unknown>) {
    return this.access.can(user, 'delete', this.record.subject, row);
  }

  /** Out of the recycle bin (an action only with `softDelete`). */
  restore(user: Principal | null, row?: Record<string, unknown>) {
    return this.access.can(user, 'restore', this.record.subject, row);
  }
}
