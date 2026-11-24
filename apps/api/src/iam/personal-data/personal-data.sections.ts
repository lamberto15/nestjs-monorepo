import { Injectable } from '@nestjs/common';
import { DELETED_USER_NAME } from './account-deletion.job.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from './personal-data.js';
import { PersonalDataRepository } from './personal-data.repository.js';

/**
 * The account itself (iam/auth's tables): the profile without its
 * password hash, the memberships, where it is signed in. Its erasure is
 * the deletion job's last step (the anonymisation), not a section's.
 */
@PersonalData({ name: 'account', scopes: ['account'] })
@Injectable()
export class AccountSection implements PersonalDataSection {
  constructor(private readonly repository: PersonalDataRepository) {}

  async rows({ userId }: PersonalDataSubject) {
    const profile = await this.repository.findUser(userId);
    const { passwordHash: _hash, ...rest } = profile ?? {};
    const [joined, signedIn, tokens] = await Promise.all([
      this.repository.membershipsOf(userId),
      this.repository.sessionsOf(userId),
      this.repository.refreshTokensOf(userId),
    ]);
    return [
      ...(profile ? [{ kind: 'profile', ...rest }] : []),
      ...joined.map((row) => ({ kind: 'membership', ...row })),
      ...signedIn.map((row) => ({ kind: 'session', ...row })),
      ...tokens.map((row) => ({ kind: 'refreshToken', ...row })),
    ];
  }
}

/** Every consent the person gave or withdrew. Kept at the deletion, as proof (the account is anonymised). */
@PersonalData({ name: 'consents', scopes: ['account'] })
@Injectable()
export class ConsentsSection implements PersonalDataSection {
  constructor(private readonly repository: PersonalDataRepository) {}

  rows({ userId }: PersonalDataSubject) {
    return this.repository.consentsOf(userId);
  }
}

/**
 * What the person did, as the audit log holds it, in each tenant and in
 * none. At the deletion the entries stay (an audit trail) but lose the
 * address they were labelled with: "Deleted user", the actor key kept.
 */
@PersonalData({ name: 'audit', scopes: ['tenant', 'account'] })
@Injectable()
export class AuditSection implements PersonalDataSection {
  constructor(private readonly repository: PersonalDataRepository) {}

  async *rows({ key }: PersonalDataSubject) {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.repository.auditEntriesOf(key, cursor, 1000);
      if (page.length === 0) return;
      yield page;
      cursor = page[page.length - 1]!.id;
    }
  }

  async erase({ key }: PersonalDataSubject) {
    await this.repository.relabelAuditEntries(key, DELETED_USER_NAME);
  }
}
