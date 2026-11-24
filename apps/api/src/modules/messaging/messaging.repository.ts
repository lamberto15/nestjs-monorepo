import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import {
  messagingDevices as devices,
  messagingUsage,
  phoneNumbers,
} from './messaging.tables.js';

type NewDevice = typeof devices.$inferInsert;

/**
 * The messaging queries: a person's devices and number, and the toll-fraud
 * counters, in the caller's tenant and transaction (`@InjectTransaction()`).
 * A token or a number is found by its blind index (EncryptionService); the
 * values come sealed from the caller.
 */
@Injectable()
export class MessagingRepository {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly encryption: EncryptionService,
  ) {}

  // ---- devices ----

  async findDeviceByToken(token: string) {
    const [row] = await this.db
      .select()
      .from(devices)
      .where(this.encryption.lookup(devices.token, token));
    return row;
  }

  async updateDevice(id: string, values: Partial<NewDevice>) {
    const [row] = await this.db
      .update(devices)
      .set(values)
      .where(eq(devices.id, id))
      .returning();
    return row!;
  }

  async insertDevice(values: NewDevice) {
    const [row] = await this.db.insert(devices).values(values).returning();
    return row!;
  }

  devicesOf(userId: string) {
    return this.db
      .select()
      .from(devices)
      .where(eq(devices.userId, userId))
      .orderBy(devices.createdAt);
  }

  async findDevice(userId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.userId, userId)));
    return row;
  }

  /** Deletes one of the user's devices; true when there was one. */
  async deleteDevice(userId: string, id: string) {
    const removed = await this.db
      .delete(devices)
      .where(and(eq(devices.id, id), eq(devices.userId, userId)))
      .returning({ id: devices.id });
    return removed.length > 0;
  }

  async deviceIdsOf(userId: string) {
    const rows = await this.db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.userId, userId));
    return rows.map((row) => row.id);
  }

  /** Deletes the devices not seen since `before`; how many went. */
  async deleteDevicesSeenBefore(before: Date) {
    const removed = await this.db
      .delete(devices)
      .where(lt(devices.lastSeenAt, before))
      .returning({ id: devices.id });
    return removed.length;
  }

  /** A person's devices, without their tokens (their export). */
  deviceSummariesOf(userId: string) {
    return this.db
      .select({
        id: devices.id,
        platform: devices.platform,
        name: devices.name,
        lastSeenAt: devices.lastSeenAt,
        createdAt: devices.createdAt,
      })
      .from(devices)
      .where(eq(devices.userId, userId));
  }

  async deleteDevicesOf(userId: string) {
    await this.db.delete(devices).where(eq(devices.userId, userId));
  }

  // ---- the phone number ----

  async phoneOf(userId: string) {
    const [row] = await this.db
      .select()
      .from(phoneNumbers)
      .where(eq(phoneNumbers.userId, userId));
    return row;
  }

  /** A number not opted out. */
  async sendablePhoneOf(userId: string) {
    const [row] = await this.db
      .select()
      .from(phoneNumbers)
      .where(
        and(eq(phoneNumbers.userId, userId), isNull(phoneNumbers.optedOutAt)),
      );
    return row;
  }

  /** Sets the user's number (sealed), unverified and opted in. */
  async savePhone(
    userId: string,
    sealed: { phone: string; phoneIndex: string },
  ) {
    await this.db
      .insert(phoneNumbers)
      .values({ userId, ...sealed })
      .onConflictDoUpdate({
        target: phoneNumbers.userId,
        set: { ...sealed, verifiedAt: null, optedOutAt: null },
      });
  }

  /** Deletes the user's number; true when there was one. */
  async deletePhone(userId: string) {
    const removed = await this.db
      .delete(phoneNumbers)
      .where(eq(phoneNumbers.userId, userId))
      .returning({ id: phoneNumbers.id });
    return removed.length > 0;
  }

  /** Marks the user's number verified; false when there is none. */
  async verifyPhone(userId: string) {
    const verified = await this.db
      .update(phoneNumbers)
      .set({ verifiedAt: new Date() })
      .where(eq(phoneNumbers.userId, userId))
      .returning({ id: phoneNumbers.id });
    return verified.length > 0;
  }

  /** Every row of this number (normalized), whoever's. */
  phonesByNumber(normalized: string) {
    return this.db
      .select({
        id: phoneNumbers.id,
        userId: phoneNumbers.userId,
        optedOutAt: phoneNumbers.optedOutAt,
      })
      .from(phoneNumbers)
      .where(this.encryption.lookup(phoneNumbers.phone, normalized));
  }

  async setOptedOut(id: string, optedOutAt: Date | null) {
    await this.db
      .update(phoneNumbers)
      .set({ optedOutAt })
      .where(eq(phoneNumbers.id, id));
  }

  phonesOf(userId: string) {
    return this.db
      .select()
      .from(phoneNumbers)
      .where(eq(phoneNumbers.userId, userId));
  }

  // ---- the toll-fraud counters ----

  /** The counter after adding `step`: an atomic upsert. */
  async increment(day: string, counter: string, step: number) {
    const [row] = await this.db
      .insert(messagingUsage)
      .values({ day, counter, count: step })
      .onConflictDoUpdate({
        target: [
          messagingUsage.tenantId,
          messagingUsage.day,
          messagingUsage.counter,
        ],
        set: { count: sql`${messagingUsage.count} + ${step}` },
      })
      .returning({ count: messagingUsage.count });
    return row?.count ?? 0;
  }

  /**
   * Deletes the daily counters of days before `dailyBefore` and the month's
   * spend of months before `spendBefore`; how many went.
   */
  async deleteCounters(dailyBefore: string, spendBefore: string) {
    const removed = await this.db
      .delete(messagingUsage)
      .where(
        or(
          and(
            ne(messagingUsage.counter, 'spend'),
            lt(messagingUsage.day, dailyBefore),
          ),
          and(
            eq(messagingUsage.counter, 'spend'),
            lt(messagingUsage.day, spendBefore),
          ),
        ),
      )
      .returning({ id: messagingUsage.id });
    return removed.length;
  }
}
