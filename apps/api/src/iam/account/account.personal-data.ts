import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../personal-data/personal-data.js';
import { AccountRepository } from './account.repository.js';
import { PasskeysRepository } from './passkeys.repository.js';

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
  constructor(
    private readonly accounts: AccountRepository,
    private readonly passkeys: PasskeysRepository,
  ) {}

  async rows({ userId }: PersonalDataSubject) {
    const [identities, keys, enabled] = await Promise.all([
      this.accounts.identitiesOf(userId),
      this.passkeys.list(userId),
      this.accounts.mfaConfirmed(userId),
    ]);
    return [
      ...identities.map(({ provider, subject, email, createdAt }) => ({
        kind: 'identity',
        provider,
        subject,
        email,
        createdAt,
      })),
      // Without key material.
      ...keys.map((key) => ({
        kind: 'passkey',
        id: key.id,
        name: key.name,
        deviceType: key.deviceType,
        backedUp: key.backedUp,
        transports: key.transports,
        aaguid: key.aaguid,
        lastUsedAt: key.lastUsedAt,
        createdAt: key.createdAt,
      })),
      { kind: 'twoFactor', enabled },
    ];
  }

  async erase({ userId }: PersonalDataSubject) {
    await this.accounts.eraseSignInMethods(userId);
  }
}
