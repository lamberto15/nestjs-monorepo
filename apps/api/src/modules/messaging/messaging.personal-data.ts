import { Injectable } from '@nestjs/common';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { MessagingRepository } from './messaging.repository.js';
import { MessagingService } from './messaging.service.js';
import { phoneNumbers } from './messaging.tables.js';

/**
 * The person's push devices (without their tokens) and their phone number:
 * in their export, deleted with their account (and a code still waiting).
 */
@PersonalData({ name: 'messaging', scopes: ['account'] })
@Injectable()
export class MessagingPersonalData implements PersonalDataSection {
  constructor(
    private readonly repository: MessagingRepository,
    private readonly encryption: EncryptionService,
    private readonly messaging: MessagingService,
  ) {}

  async rows({ userId }: PersonalDataSubject) {
    const [devices, phones] = await Promise.all([
      this.repository.deviceSummariesOf(userId),
      this.repository.phonesOf(userId),
    ]);
    return [
      ...devices.map((device) => ({ kind: 'device', ...device })),
      ...phones.map((row) => ({
        kind: 'phone',
        id: row.id,
        phone: this.encryption.decrypt(phoneNumbers.phone, row.phone),
        verified: row.verifiedAt !== null,
        optedOut: row.optedOutAt !== null,
      })),
    ];
  }

  async erase({ userId }: PersonalDataSubject) {
    await this.repository.deleteDevicesOf(userId);
    await this.repository.deletePhone(userId);
    await this.messaging.forgetCode(userId);
  }
}
