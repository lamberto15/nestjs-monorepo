import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';

/**
 * A change to an account and its audit entry, in one transaction, in no
 * tenant: an account's credentials are the person's, whatever tenant the
 * request acts in, and their entries belong to no tenant's log (as the
 * sign-in entries iam/audit writes). Every account change goes through it.
 */
@Injectable()
export class AccountWork {
  constructor(
    private readonly tenancy: Tenancy,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
  ) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.tenancy.run(null, () => this.txHost.withTransaction(work));
  }
}
