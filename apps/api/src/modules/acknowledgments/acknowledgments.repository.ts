import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { memberships, users } from '../../iam/auth/auth.tables.js';
import {
  acknowledgmentVersions as versions,
  recordAcknowledgments as acks,
} from './acknowledgments.tables.js';

type NewAcknowledgment = typeof acks.$inferInsert;

/** One record's version: the requests of a version are asked about it. */
interface Version {
  subject: string;
  recordId: string;
  version: number;
}

const ofVersion = ({ subject, recordId, version }: Version) =>
  and(
    eq(acks.subject, subject),
    eq(acks.recordId, recordId),
    eq(acks.version, version),
  );

/** The acknowledgments' queries, in the caller's transaction and tenant. */
@Injectable()
export class AcknowledgmentsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** The record's version, or undefined while nobody was ever asked. */
  async versionOf(subject: string, recordId: string) {
    const [row] = await this.db
      .select({ version: versions.version })
      .from(versions)
      .where(
        and(eq(versions.subject, subject), eq(versions.recordId, recordId)),
      );
    return row?.version;
  }

  /** Starts counting the record's versions (once). */
  async insertVersion(subject: string, recordId: string) {
    await this.db
      .insert(versions)
      .values({ subject, recordId })
      .onConflictDoNothing();
  }

  async bumpVersion(subject: string, recordId: string) {
    await this.db
      .update(versions)
      .set({ version: sql`${versions.version} + 1` })
      .where(
        and(eq(versions.subject, subject), eq(versions.recordId, recordId)),
      );
  }

  /** Deletes the records' requests and versions. */
  async deleteOfRecords(subject: string, ids: string[]) {
    await this.db
      .delete(acks)
      .where(and(eq(acks.subject, subject), inArray(acks.recordId, ids)));
    await this.db
      .delete(versions)
      .where(
        and(eq(versions.subject, subject), inArray(versions.recordId, ids)),
      );
  }

  async countOf(version: Version) {
    const [{ total } = { total: 0 }] = await this.db
      .select({ total: count() })
      .from(acks)
      .where(ofVersion(version));
    return total;
  }

  /** A version's requests of these recipients. */
  async ofRecipients(version: Version, recipients: string[]) {
    return this.db
      .select()
      .from(acks)
      .where(and(ofVersion(version), inArray(acks.recipient, recipients)));
  }

  /** A version's requests in the order they were asked. */
  async ofVersion(version: Version) {
    return this.db
      .select()
      .from(acks)
      .where(ofVersion(version))
      .orderBy(acks.createdAt, acks.id);
  }

  /** A version's requests not yet answered, of the named recipients when given. */
  async openOf(version: Version, recipients?: string[]) {
    return this.db
      .select()
      .from(acks)
      .where(
        and(
          ofVersion(version),
          isNull(acks.acknowledgedAt),
          recipients?.length ? inArray(acks.recipient, recipients) : undefined,
        ),
      );
  }

  /** The recipient's request of a version, locked for the answer. */
  async lockOfRecipient(version: Version, recipient: string) {
    const [row] = await this.db
      .select()
      .from(acks)
      .where(and(ofVersion(version), eq(acks.recipient, recipient)))
      .for('update');
    return row;
  }

  /** A request of the record, any version. */
  async findOfRecord(subject: string, recordId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(acks)
      .where(
        and(
          eq(acks.id, id),
          eq(acks.subject, subject),
          eq(acks.recordId, recordId),
        ),
      );
    return row;
  }

  async insert(rows: NewAcknowledgment[]) {
    await this.db.insert(acks).values(rows);
  }

  async setDue(ids: string[], dueAt: Date) {
    await this.db.update(acks).set({ dueAt }).where(inArray(acks.id, ids));
  }

  async markAcknowledged(id: string) {
    const [row] = await this.db
      .update(acks)
      .set({ acknowledgedAt: new Date() })
      .where(eq(acks.id, id))
      .returning();
    return row!;
  }

  async markReminded(ids: string[], at: Date) {
    await this.db
      .update(acks)
      .set({ lastRemindedAt: at, reminders: sql`${acks.reminders} + 1` })
      .where(inArray(acks.id, ids));
  }

  async delete(id: string) {
    await this.db.delete(acks).where(eq(acks.id, id));
  }

  /**
   * The recipient's requests, newest first: those still to answer (of the
   * record's current version) or those answered.
   */
  async ofRecipient(
    recipient: string,
    status: 'pending' | 'acknowledged',
    limit: number,
  ) {
    const rows = await this.db
      .select({ row: acks })
      .from(acks)
      .leftJoin(
        versions,
        and(
          eq(versions.subject, acks.subject),
          eq(versions.recordId, acks.recordId),
        ),
      )
      .where(
        and(
          eq(acks.recipient, recipient),
          status === 'pending'
            ? and(
                isNull(acks.acknowledgedAt),
                // A request for an earlier version can no longer be answered.
                eq(acks.version, sql`coalesce(${versions.version}, 1)`),
              )
            : isNotNull(acks.acknowledgedAt),
        ),
      )
      .orderBy(desc(acks.id))
      .limit(limit);
    return rows.map(({ row }) => row);
  }

  /** Which of these users are active members of the tenant, active themselves. */
  async activeMemberIds(tenantId: string, ids: string[]) {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(
        and(
          inArray(users.id, ids),
          eq(users.active, true),
          eq(memberships.tenantId, tenantId),
          eq(memberships.active, true),
        ),
      );
    return rows.map((row) => row.id);
  }

  async userNames(ids: string[]) {
    return this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, ids));
  }

  async ofPerson(recipient: string) {
    return this.db.select().from(acks).where(eq(acks.recipient, recipient));
  }

  async deleteOfPerson(recipient: string) {
    await this.db.delete(acks).where(eq(acks.recipient, recipient));
  }
}
