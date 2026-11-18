import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../personal-data/personal-data.js';
import {
  accountDevices,
  emailTokens,
  mfaAuthenticators,
  mfaFailures,
  mfaRecoveryCodes,
  oidcLogins,
  passkeys,
  passwordHistory,
  userIdentities,
} from './account.tables.js';

/**
 * What the account's sign-in methods hold about a person: linked
 * providers, passkeys (without key material), whether two-factor is on.
 * At the deletion every way back in goes: providers, passkeys, the
 * authenticator and its codes, the password history, known devices,
 * pending links.
 */
@PersonalData({ name: 'sign-in-methods', scopes: ['account'] })
@Injectable()
export class AccountPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ userId }: PersonalDataSubject) {
    const [identities, keys, [authenticator]] = await Promise.all([
      this.db
        .select({
          provider: userIdentities.provider,
          subject: userIdentities.subject,
          email: userIdentities.email,
          createdAt: userIdentities.createdAt,
        })
        .from(userIdentities)
        .where(eq(userIdentities.userId, userId)),
      this.db
        .select({
          id: passkeys.id,
          name: passkeys.name,
          deviceType: passkeys.deviceType,
          backedUp: passkeys.backedUp,
          transports: passkeys.transports,
          aaguid: passkeys.aaguid,
          lastUsedAt: passkeys.lastUsedAt,
          createdAt: passkeys.createdAt,
        })
        .from(passkeys)
        .where(eq(passkeys.userId, userId)),
      this.db
        .select({ confirmed: mfaAuthenticators.confirmed })
        .from(mfaAuthenticators)
        .where(eq(mfaAuthenticators.id, userId)),
    ]);
    return [
      ...identities.map((row) => ({ kind: 'identity', ...row })),
      ...keys.map((row) => ({ kind: 'passkey', ...row })),
      { kind: 'twoFactor', enabled: authenticator?.confirmed ?? false },
    ];
  }

  async erase({ userId }: PersonalDataSubject) {
    await this.db
      .delete(userIdentities)
      .where(eq(userIdentities.userId, userId));
    await this.db.delete(passkeys).where(eq(passkeys.userId, userId));
    await this.db
      .delete(passwordHistory)
      .where(eq(passwordHistory.userId, userId));
    await this.db
      .delete(mfaAuthenticators)
      .where(eq(mfaAuthenticators.id, userId));
    await this.db
      .delete(mfaRecoveryCodes)
      .where(eq(mfaRecoveryCodes.userId, userId));
    await this.db.delete(mfaFailures).where(eq(mfaFailures.userId, userId));
    await this.db
      .delete(accountDevices)
      .where(eq(accountDevices.userId, userId));
    await this.db.delete(emailTokens).where(eq(emailTokens.userId, userId));
    await this.db.delete(oidcLogins).where(eq(oidcLogins.linkUserId, userId));
  }
}
