import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { MessagingService } from './messaging.service.js';
import { messagingDevices, phoneNumbers } from './messaging.tables.js';

/**
 * The person's push devices (without their tokens) and their phone number:
 * in their export, deleted with their account (and a code still waiting).
 */
@PersonalData({ name: 'messaging', scopes: ['account'] })
@Injectable()
export class MessagingPersonalData implements PersonalDataSection {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly encryption: EncryptionService,
    private readonly messaging: MessagingService,
  ) {}

  async rows({ userId }: PersonalDataSubject) {
    const [devices, phones] = await Promise.all([
      this.db
        .select({
          id: messagingDevices.id,
          platform: messagingDevices.platform,
          name: messagingDevices.name,
          lastSeenAt: messagingDevices.lastSeenAt,
          createdAt: messagingDevices.createdAt,
        })
        .from(messagingDevices)
        .where(eq(messagingDevices.userId, userId)),
      this.db
        .select()
        .from(phoneNumbers)
        .where(eq(phoneNumbers.userId, userId)),
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
    await this.db
      .delete(messagingDevices)
      .where(eq(messagingDevices.userId, userId));
    await this.db.delete(phoneNumbers).where(eq(phoneNumbers.userId, userId));
    await this.messaging.forgetCode(userId);
  }
}
