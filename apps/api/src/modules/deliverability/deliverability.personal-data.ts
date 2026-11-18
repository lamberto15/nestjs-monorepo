import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { normalizeAddress } from '../../core/mail/mail-suppression.js';
import { users } from '../../iam/auth/auth.tables.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { mailEvents, mailSuppressions } from './deliverability.tables.js';

/**
 * The suppression entry and the delivery events of the person's own
 * address: in their export. With their account both go: the address is
 * personal data, and once the account is gone nothing mails it (a new report
 * after that lists it again).
 */
@PersonalData({ name: 'mail-deliverability', scopes: ['account'] })
@Injectable()
export class DeliverabilityPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async *rows({ userId }: PersonalDataSubject) {
    const address = await this.addressOf(userId);
    if (!address) return;
    yield (
      await this.db
        .select()
        .from(mailSuppressions)
        .where(eq(mailSuppressions.address, address))
    ).map((row) => ({ kind: 'suppression', ...row }));
    yield (
      await this.db
        .select()
        .from(mailEvents)
        .where(eq(mailEvents.address, address))
        .orderBy(desc(mailEvents.id))
        .limit(1000)
    ).map((row) => ({ kind: 'event', ...row }));
  }

  async erase({ userId }: PersonalDataSubject) {
    const address = await this.addressOf(userId);
    if (!address) return;
    await this.db.delete(mailEvents).where(eq(mailEvents.address, address));
    await this.db
      .delete(mailSuppressions)
      .where(eq(mailSuppressions.address, address));
  }

  private async addressOf(userId: string) {
    const [account] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    return account ? normalizeAddress(account.email) : null;
  }
}
