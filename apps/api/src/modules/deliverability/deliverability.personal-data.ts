import { Injectable } from '@nestjs/common';
import { normalizeAddress } from '../../core/mail/mail-suppression.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { DeliverabilityRepository } from './deliverability.repository.js';

/**
 * The suppression entry and the delivery events of the person's own
 * address: in their export. With their account both go: the address is
 * personal data, and once the account is gone nothing mails it (a new report
 * after that lists it again).
 */
@PersonalData({ name: 'mail-deliverability', scopes: ['account'] })
@Injectable()
export class DeliverabilityPersonalData implements PersonalDataSection {
  constructor(private readonly repository: DeliverabilityRepository) {}

  async *rows({ userId }: PersonalDataSubject) {
    const address = await this.addressOf(userId);
    if (!address) return;
    yield (await this.repository.suppressionsOf(address)).map((row) => ({
      kind: 'suppression',
      ...row,
    }));
    yield (await this.repository.eventsOf(address, 1000)).map((row) => ({
      kind: 'event',
      ...row,
    }));
  }

  async erase({ userId }: PersonalDataSubject) {
    const address = await this.addressOf(userId);
    if (!address) return;
    await this.repository.deleteOfAddress(address);
  }

  private async addressOf(userId: string) {
    const email = await this.repository.emailOf(userId);
    return email !== undefined ? normalizeAddress(email) : null;
  }
}
