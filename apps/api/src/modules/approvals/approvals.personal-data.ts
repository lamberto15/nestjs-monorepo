import { Injectable } from '@nestjs/common';
import { systemPrincipal } from '../../iam/auth/principal.js';
import { DELETED_USER_NAME } from '../../iam/personal-data/account-deletion.job.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { ApprovalEngine } from './approval-engine.service.js';
import { ApprovalDelegationsRepository } from './approval-delegations.repository.js';
import { ApprovalsRepository } from './approvals.repository.js';

const DELETION = systemPrincipal({
  key: 'account-deletion',
  label: 'Account deletion',
});

/**
 * The requests the person made, their decisions and their delegations: in
 * their export. At the deletion requests and decisions stay (other people's
 * records depend on them), the names copied onto them go; their pending
 * assignments close and their stages are settled again; their delegations
 * end.
 */
@PersonalData({ name: 'approvals', scopes: ['tenant'] })
@Injectable()
export class ApprovalsPersonalData implements PersonalDataSection {
  constructor(
    private readonly repository: ApprovalsRepository,
    private readonly delegations: ApprovalDelegationsRepository,
    private readonly engine: ApprovalEngine,
  ) {}

  async *rows({ key, userId }: PersonalDataSubject) {
    yield (await this.repository.requestsOf(key)).map((row) => ({
      kind: 'request',
      ...row,
    }));
    yield (await this.repository.decisionsOf(userId)).map((row) => ({
      kind: 'decision',
      ...row,
    }));
    yield (await this.delegations.givenBy(userId)).map((row) => ({
      kind: 'delegation',
      ...row,
    }));
  }

  async erase({ key, userId }: PersonalDataSubject) {
    // Closes their pending assignments and ends their delegations.
    await this.engine.release(userId, DELETION);
    await this.repository.renamePerson(key, userId, DELETED_USER_NAME);
  }
}
