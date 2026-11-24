import { Transactional } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { RecordRow } from '../records/record.js';
import { Records } from '../records/records.service.js';
import {
  type AcknowledgmentView,
  MAX_PER_VERSION,
  type MyAcknowledgmentView,
} from './acknowledgments.schemas.js';
import { AcknowledgmentsRepository } from './acknowledgments.repository.js';
import type { RecordAcknowledgment } from './acknowledgments.tables.js';

/** A reminder goes to the same person at most this often. */
export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A list of someone's own acknowledgments holds at most this many. */
const MINE_LIMIT = 100;

/** The record a request is about, as the routes found it (readable, and changeable when asking). */
export interface AcknowledgedRecord {
  subject: string;
  row: RecordRow;
}

/**
 * "Did these people read this version of this record?": a request per
 * person and version, answered by the person (it records who confirmed,
 * which version, when; no signature is implied). Whoever may change the
 * record asks, reminds, withdraws and sees the dashboard; the recipient
 * (who must still read the record) acknowledges; asking or acknowledging
 * again changes nothing. Every write is audited.
 */
@Injectable()
export class AcknowledgmentsService {
  constructor(
    private readonly repository: AcknowledgmentsRepository,
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly i18n: I18nService,
  ) {}

  private text(key: string, args: Record<string, unknown> = {}): string {
    return this.i18n.translate(`acknowledgments.errors.${key}`, { args });
  }

  /** The record's current version (1 until it changed after a first request). */
  async versionOf(subject: string, recordId: string) {
    return (await this.repository.versionOf(subject, recordId)) ?? 1;
  }

  /** The record changed: a new version, when someone was ever asked about it. */
  async bump(subject: string, recordId: string) {
    await this.repository.bumpVersion(subject, recordId);
  }

  /** Records deleted for good take their requests and versions along. */
  async forget(subject: string, recordIds: readonly string[]) {
    await this.repository.deleteOfRecords(subject, [...recordIds]);
  }

  private titleOf({ subject, row }: AcknowledgedRecord) {
    const named = [row.title, row.name].find((v) => typeof v === 'string' && v);
    return (
      (named as string | undefined) ??
      `${this.records.of(subject).declaration.noun} ${row.id}`
    );
  }

  private linkOf(subject: string, recordId: string) {
    return `/${this.records.of(subject).declaration.path}/${recordId}`;
  }

  /**
   * Asks the people to acknowledge the record's current version; those
   * already asked keep their answer (a new deadline replaces the old for
   * those who haven't answered).
   */
  @Transactional()
  async request(
    principal: Principal,
    record: AcknowledgedRecord,
    recipients: string[],
    dueAt: string | undefined,
    ip?: string,
  ) {
    const { subject, row } = record;
    const due = dueAt ? new Date(dueAt) : null;
    if (due && due.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'acknowledgment_due_in_past',
        message: this.text('dueInPast'),
      });
    }
    const keys = [...new Set(recipients)];
    await this.assertRecipients(record, keys);
    // The record's version row: the record's later changes count from here.
    await this.repository.insertVersion(subject, row.id);
    const version = await this.versionOf(subject, row.id);
    const mine = { subject, recordId: row.id, version };
    const total = await this.repository.countOf(mine);
    const have = await this.repository.ofRecipients(mine, keys);
    const fresh = keys.filter((key) => !have.some((a) => a.recipient === key));
    if (total + fresh.length > MAX_PER_VERSION) {
      throw new ConflictException({
        code: 'acknowledgment_limit',
        message: this.text('limit', { max: MAX_PER_VERSION }),
      });
    }
    if (fresh.length) {
      await this.repository.insert(
        fresh.map((recipient) => ({
          subject,
          recordId: row.id,
          version,
          recipient,
          requestedBy: principalKey(principal),
          dueAt: due,
        })),
      );
    }
    const open = have.filter((a) => !a.acknowledgedAt);
    if (due && open.length) {
      await this.repository.setDue(
        open.map((a) => a.id),
        due,
      );
    }
    if (fresh.length) {
      await this.audit.record(principal, {
        action: 'acknowledgment.requested',
        targetType: subject,
        targetId: row.id,
        details: {
          version,
          recipients: fresh,
          dueAt: due?.toISOString() ?? null,
        },
        ip,
      });
      await this.tell(
        'acknowledgment.requested',
        record,
        version,
        principal,
        fresh,
        due,
      );
    }
    return this.views(await this.repository.ofRecipients(mine, keys));
  }

  /** The completion dashboard of a version (default: the current one). */
  async status(subject: string, recordId: string, version?: number) {
    const v = version ?? (await this.versionOf(subject, recordId));
    const found = await this.repository.ofVersion({
      subject,
      recordId,
      version: v,
    });
    const items = await this.views(found);
    const acknowledged = items.filter((i) => i.acknowledgedAt).length;
    return {
      recordId,
      version: v,
      total: items.length,
      acknowledged,
      pending: items.length - acknowledged,
      overdue: items.filter((i) => i.overdue).length,
      items,
    };
  }

  /**
   * Records that the caller acknowledged the record's current version;
   * again changes nothing. A 404 for anyone nobody asked (as for a record
   * they may not read).
   */
  @Transactional()
  async acknowledge(
    principal: Principal,
    record: AcknowledgedRecord,
    ip?: string,
  ) {
    const { subject, row } = record;
    const version = await this.versionOf(subject, row.id);
    const mine = await this.repository.lockOfRecipient(
      { subject, recordId: row.id, version },
      principalKey(principal),
    );
    if (!mine) throw new NotFoundException();
    if (mine.acknowledgedAt) return (await this.views([mine]))[0]!;
    const updated = await this.repository.markAcknowledged(mine.id);
    await this.audit.record(principal, {
      action: 'acknowledgment.acknowledged',
      targetType: subject,
      targetId: row.id,
      details: { version },
      ip,
    });
    return (await this.views([updated]))[0]!;
  }

  /** Reminds those who have not acknowledged (or the named ones), but not twice in 24 hours. */
  @Transactional()
  async remind(
    principal: Principal,
    record: AcknowledgedRecord,
    recipients: string[] | undefined,
    ip?: string,
  ) {
    const { subject, row } = record;
    const now = new Date();
    const version = await this.versionOf(subject, row.id);
    const open = await this.repository.openOf(
      { subject, recordId: row.id, version },
      recipients,
    );
    const due = open.filter(
      (a) =>
        !a.lastRemindedAt ||
        now.getTime() - a.lastRemindedAt.getTime() >= REMINDER_INTERVAL_MS,
    );
    if (due.length) {
      await this.repository.markReminded(
        due.map((a) => a.id),
        now,
      );
      await this.audit.record(principal, {
        action: 'acknowledgment.reminded',
        targetType: subject,
        targetId: row.id,
        details: { version, recipients: due.map((a) => a.recipient) },
        ip,
      });
      for (const a of due) {
        await this.tell(
          'acknowledgment.reminder',
          record,
          version,
          principal,
          [a.recipient],
          a.dueAt,
        );
      }
    }
    return { reminded: due.length, skipped: open.length - due.length };
  }

  /** Withdraws a request nobody has answered; an answer stays. */
  @Transactional()
  async withdraw(
    principal: Principal,
    record: AcknowledgedRecord,
    id: string,
    ip?: string,
  ) {
    const { subject, row } = record;
    const found = await this.repository.findOfRecord(subject, row.id, id);
    if (!found) throw new NotFoundException();
    if (found.acknowledgedAt) {
      throw new ConflictException({
        code: 'acknowledgment_answered',
        message: this.text('answered'),
      });
    }
    await this.repository.delete(id);
    await this.audit.record(principal, {
      action: 'acknowledgment.withdrawn',
      targetType: subject,
      targetId: row.id,
      details: { version: found.version, recipient: found.recipient },
      ip,
    });
  }

  /**
   * The caller's own acknowledgments, newest first: the ones to do
   * (`pending`, of the record's current version) or done; only of records
   * they may still read.
   */
  async mine(principal: Principal, status: 'pending' | 'acknowledged') {
    const found = await this.repository.ofRecipient(
      principalKey(principal),
      status,
      MINE_LIMIT,
    );
    const items: MyAcknowledgmentView[] = [];
    for (const row of found) {
      const record = await this.readable(principal, row.subject, row.recordId);
      if (!record) continue;
      const [view] = await this.views([row]);
      items.push({
        ...view!,
        title: this.titleOf(record),
        link: this.linkOf(row.subject, row.recordId),
      });
    }
    return { items };
  }

  /** The record, when the principal may read it (and its subject is still declared). */
  private async readable(principal: Principal, subject: string, id: string) {
    try {
      const row = await this.records
        .of(subject)
        .store.findOne(id, { visibleTo: principal });
      return { subject, row };
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  /** Active members of the tenant who may read the record, else a 400. */
  private async assertRecipients(
    { subject, row }: AcknowledgedRecord,
    keys: string[],
  ) {
    const ids = keys.map((key) => key.slice('user:'.length));
    const members = new Set(
      await this.repository.activeMemberIds(
        requireTenantId('An acknowledgment'),
        ids,
      ),
    );
    for (const id of ids) {
      const user = { kind: 'user', id } as UserPrincipal;
      if (
        !members.has(id) ||
        !(await this.access.can(user, 'read', subject, row))
      ) {
        throw new BadRequestException({
          code: 'acknowledgment_recipient_invalid',
          message: this.text('recipientInvalid', { key: `user:${id}` }),
        });
      }
    }
  }

  private async tell(
    type: 'acknowledgment.requested' | 'acknowledgment.reminder',
    record: AcknowledgedRecord,
    version: number,
    by: Principal,
    to: string[],
    due: Date | null,
  ) {
    await this.notifications.notify({
      type,
      to,
      data: {
        subject: record.subject,
        recordId: record.row.id,
        version,
        title: this.titleOf(record),
        by: by.name,
        dueAt: due?.toISOString() ?? null,
      },
      link: this.linkOf(record.subject, record.row.id),
    });
  }

  private async views(
    found: RecordAcknowledgment[],
  ): Promise<AcknowledgmentView[]> {
    const ids = [
      ...new Set(found.map((a) => a.recipient.slice('user:'.length))),
    ];
    const names = new Map(
      ids.length
        ? (await this.repository.userNames(ids)).map((user) => [
            `user:${user.id}`,
            user.name,
          ])
        : [],
    );
    const now = Date.now();
    return found.map((a) => ({
      id: a.id,
      subject: a.subject,
      recordId: a.recordId,
      version: a.version,
      recipient: a.recipient,
      recipientName: names.get(a.recipient) ?? null,
      requestedBy: a.requestedBy,
      dueAt: a.dueAt?.toISOString() ?? null,
      overdue: !a.acknowledgedAt && !!a.dueAt && a.dueAt.getTime() < now,
      reminders: a.reminders,
      lastRemindedAt: a.lastRemindedAt?.toISOString() ?? null,
      acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
    }));
  }
}
