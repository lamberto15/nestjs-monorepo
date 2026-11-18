import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Module } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { StorageDisk } from '@nestjs/storage';
import { eq, inArray } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import {
  recordsTenant,
  testItemModules,
  unitWithLead,
} from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { normalizeAddress } from '../../core/mail/mail-suppression.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { users } from '../../iam/auth/auth.tables.js';
import { PersonalDataModule } from '../../iam/personal-data/personal-data.module.js';
import {
  type PersonalDataBatch,
  PersonalDataService,
} from '../../iam/personal-data/personal-data.service.js';
import { AcknowledgmentsPersonalData } from '../acknowledgments/acknowledgments.personal-data.js';
import { recordAcknowledgments } from '../acknowledgments/acknowledgments.tables.js';
import { AiPersonalData } from '../ai/ai.personal-data.js';
import { aiRuns } from '../ai/ai.tables.js';
import { ApprovalEngine } from '../approvals/approval-engine.service.js';
import { ApprovalsPersonalData } from '../approvals/approvals.personal-data.js';
import {
  approvalAssignments,
  approvalDelegations,
  approvalEvents,
  approvalRequests,
} from '../approvals/approvals.tables.js';
import { AttachmentsPersonalData } from '../attachments/attachments.personal-data.js';
import { attachments } from '../attachments/attachments.tables.js';
import { AvatarsPersonalData } from '../attachments/avatars/avatars.personal-data.js';
import { userAvatars } from '../attachments/avatars/avatars.tables.js';
import { CommentsPersonalData } from '../comments/comments.personal-data.js';
import { comments } from '../comments/comments.tables.js';
import { DeliverabilityPersonalData } from '../deliverability/deliverability.personal-data.js';
import {
  mailEvents,
  mailSuppressions,
} from '../deliverability/deliverability.tables.js';
import { DocumentsPersonalData } from '../documents/documents.personal-data.js';
import { documents } from '../documents/documents.tables.js';
import { FavoritesPersonalData } from '../favorites/favorites.personal-data.js';
import { favorites } from '../favorites/favorites.tables.js';
import { MessagingPersonalData } from '../messaging/messaging.personal-data.js';
import { MessagingService } from '../messaging/messaging.service.js';
import {
  messagingDevices,
  phoneNumbers,
} from '../messaging/messaging.tables.js';
import { NotificationsPersonalData } from '../notifications/notifications.personal-data.js';
import {
  notificationPreferences,
  notifications,
  pushDevices,
  recordSubscriptions,
} from '../notifications/notifications.tables.js';
import { RecentsPersonalData } from '../recents/recents.personal-data.js';
import { recentRecords } from '../recents/recents.tables.js';
import { RecurrencePersonalData } from '../recurrence/recurrence.personal-data.js';
import { recordSchedules } from '../recurrence/recurrence.tables.js';
import { ReportsPersonalData } from '../reports/reports.personal-data.js';
import { reportSchedules } from '../reports/reports.tables.js';
import { RevisionsPersonalData } from '../revisions/revisions.personal-data.js';
import { revisions } from '../revisions/revisions.tables.js';
import { SettingsPersonalData } from '../settings/settings.personal-data.js';
import { settingOverrides } from '../settings/settings.tables.js';
import { SharesPersonalData } from '../shares/shares.personal-data.js';
import { recordShares } from '../shares/shares.tables.js';
import { StorageModule } from '../storage/storage.module.js';
import { TemplatesPersonalData } from '../templates/templates.personal-data.js';
import { recordTemplates } from '../templates/templates.tables.js';
import { ViewsPersonalData } from '../views/views.personal-data.js';
import { savedViews } from '../views/views.tables.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-sections-${process.pid}-${Date.now()}`,
  });
});

/** Every section on its own, with stand-ins for what the others own (the engine, the cipher, the code store). */
@Module({
  providers: [
    AcknowledgmentsPersonalData,
    AiPersonalData,
    ApprovalsPersonalData,
    { provide: ApprovalEngine, useValue: { release: vi.fn() } },
    AttachmentsPersonalData,
    AvatarsPersonalData,
    CommentsPersonalData,
    DeliverabilityPersonalData,
    DocumentsPersonalData,
    FavoritesPersonalData,
    MessagingPersonalData,
    {
      provide: EncryptionService,
      useValue: { decrypt: (_c: unknown, v: string) => v },
    },
    { provide: MessagingService, useValue: { forgetCode: vi.fn() } },
    NotificationsPersonalData,
    RecentsPersonalData,
    RecurrencePersonalData,
    ReportsPersonalData,
    RevisionsPersonalData,
    SettingsPersonalData,
    SharesPersonalData,
    TemplatesPersonalData,
    ViewsPersonalData,
  ],
})
class SectionsModule {}

describe('personal data sections: export and erase (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let team: Awaited<ReturnType<typeof recordsTenant>>;
  let a: { id: string; key: string };
  let b: { id: string; key: string };

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      StorageModule,
      PersonalDataModule,
      SectionsModule,
    );
    db = app.get<Database>(getDrizzleToken());
    team = await recordsTenant(app);
    a = { id: team.editor.id, key: `user:${team.editor.id}` };
    b = { id: team.other.id, key: `user:${team.other.id}` };
  });
  afterAll(() => app?.close());

  const tenancy = () => app.get(Tenancy);
  const inTenant = <T>(work: () => Promise<T>) =>
    tenancy().run(team.tenantId, work);
  const inNone = <T>(work: () => Promise<T>) => tenancy().run(null, work);

  /** What a person's export holds in one section. */
  async function exported(userId: string, section: string) {
    const batches: PersonalDataBatch[] = [];
    await app.get(PersonalDataService).export(userId, async (batch) => {
      batches.push(batch);
    });
    return batches
      .filter((batch) => batch.section === section)
      .flatMap((batch) => batch.rows);
  }

  /** The account's deletion of one person, in both scopes. */
  async function erase(userId: string) {
    const personal = app.get(PersonalDataService);
    const tx = app.get(TransactionHost);
    await inTenant(() =>
      tx.withTransaction(() => personal.erase(userId, team.tenantId)),
    );
    await inNone(() => tx.withTransaction(() => personal.erase(userId, null)));
  }

  const uuid = () => randomUUID();

  // One person per test would need a tenant each; the sections are keyed by
  // the person, so A is erased once and each section's check runs after.
  const seeds: Record<string, () => Promise<void>> = {};
  const checks: Record<
    string,
    { before: () => Promise<void>; after: () => Promise<void> }
  > = {};
  const section = (
    name: string,
    seed: () => Promise<void>,
    before: () => Promise<void>,
    after: () => Promise<void>,
  ) => {
    seeds[name] = seed;
    checks[name] = { before, after };
  };

  const theirs = async (section: string, ...fields: string[]) => {
    const own = await exported(a.id, section);
    const other = await exported(b.id, section);
    return { own, other, fields };
  };
  void theirs;

  section(
    'favorites',
    async () => {
      await inTenant(() =>
        db.insert(favorites).values([
          { owner: a.key, kind: 'page', target: '/a', label: 'A', position: 1 },
          { owner: b.key, kind: 'page', target: '/b', label: 'B', position: 1 },
        ]),
      );
    },
    async () => {
      expect((await exported(a.id, 'favorites')).map((r) => r.label)).toEqual([
        'A',
      ]);
    },
    async () => {
      const rows = await inTenant(() => db.select().from(favorites));
      expect(rows.map((r) => r.owner)).toEqual([b.key]);
    },
  );

  section(
    'recents',
    async () => {
      await inTenant(() =>
        db.insert(recentRecords).values([
          { owner: a.key, subject: 'TestItem', recordId: 'x', label: 'A' },
          { owner: b.key, subject: 'TestItem', recordId: 'x', label: 'B' },
        ]),
      );
    },
    async () => {
      expect((await exported(a.id, 'recents')).map((r) => r.label)).toEqual([
        'A',
      ]);
    },
    async () => {
      const rows = await inTenant(() => db.select().from(recentRecords));
      expect(rows.map((r) => r.owner)).toEqual([b.key]);
    },
  );

  for (const [name, table] of [
    ['views', savedViews],
    ['templates', recordTemplates],
  ] as const) {
    section(
      name,
      async () => {
        const base = { subject: 'TestItem', scope: 'tenant' };
        const values = (owner: string, label: string, visibility: string) => ({
          ...base,
          owner,
          name: `${label}-${name}`,
          visibility: visibility as 'private',
        });
        await inTenant(() =>
          db
            .insert(table)
            .values([
              values(a.key, 'a-private', 'private'),
              values(a.key, 'a-shared', 'tenant'),
              values(b.key, 'b-private', 'private'),
            ]),
        );
      },
      async () => {
        expect(await exported(a.id, name)).toHaveLength(2);
        expect(await exported(b.id, name)).toHaveLength(1);
      },
      async () => {
        const rows = await inTenant(() => db.select().from(table));
        const byName = Object.fromEntries(rows.map((r) => [r.name, r.owner]));
        // A's private one is gone, the shared one is ownerless, B's is theirs.
        expect(byName).toEqual({
          [`a-shared-${name}`]: 'anonymous',
          [`b-private-${name}`]: b.key,
        });
      },
    );
  }

  section(
    'comments',
    async () => {
      const base = { subject: 'TestItem', recordId: uuid() };
      await inTenant(() =>
        db.insert(comments).values([
          { ...base, author: a.key, body: 'mine', mentions: [] },
          {
            ...base,
            author: b.key,
            body: `hello @${a.key}`,
            mentions: [a.key],
          },
        ]),
      );
    },
    async () => {
      expect((await exported(a.id, 'comments')).map((r) => r.body)).toEqual([
        'mine',
      ]);
    },
    async () => {
      const rows = await inTenant(() => db.select().from(comments));
      expect(
        rows
          .map((r) => [r.author, r.body, r.mentions])
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual([
        ['anonymous', '[deleted]', []],
        [b.key, 'hello @[deleted]', []],
      ]);
    },
  );

  section(
    'revisions',
    async () => {
      const base = { subject: 'TestItem', recordId: uuid(), snapshot: {} };
      await inTenant(() =>
        db.insert(revisions).values([
          { ...base, number: 1, changedBy: a.key },
          { ...base, number: 2, changedBy: b.key },
        ]),
      );
    },
    // Revisions are the records' history: nothing in the export.
    async () => {
      expect(await exported(a.id, 'revisions')).toEqual([]);
    },
    async () => {
      const rows = await inTenant(() => db.select().from(revisions));
      expect(
        rows
          .map((r) => r.changedBy)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(
        ['anonymized', b.key].sort((x, y) =>
          String(x).localeCompare(String(y)),
        ),
      );
    },
  );

  section(
    'attachments',
    async () => {
      const base = {
        subject: 'TestItem',
        recordId: uuid(),
        size: 1,
        contentType: 'text/plain',
      };
      await inTenant(() =>
        db.insert(attachments).values([
          { ...base, key: 'k/a', name: 'a.txt', uploadedBy: a.key },
          { ...base, key: 'k/b', name: 'b.txt', uploadedBy: b.key },
        ]),
      );
    },
    async () => {
      const rows = await exported(a.id, 'attachments');
      expect(rows.map((r) => r.name)).toEqual(['a.txt']);
      // The row, never the file's key.
      expect(rows[0]).not.toHaveProperty('key');
    },
    async () => {
      const rows = await inTenant(() => db.select().from(attachments));
      expect(
        rows
          .map((r) => [r.name, r.uploadedBy])
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual([
        ['a.txt', 'anonymized'],
        ['b.txt', b.key],
      ]);
    },
  );

  section(
    'documents',
    async () => {
      const base = {
        source: 'test-items',
        template: 't',
        subject: 'TestItem',
        recordId: uuid(),
        locale: 'en',
        timezone: 'UTC',
        status: 'completed' as const,
      };
      await inTenant(() =>
        db.insert(documents).values([
          { ...base, requestedBy: a.key, runToken: uuid() },
          { ...base, requestedBy: b.key },
        ]),
      );
    },
    async () => {
      const rows = await exported(a.id, 'documents');
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('runToken');
    },
    async () => {
      const rows = await inTenant(() => db.select().from(documents));
      expect(
        rows
          .map((r) => r.requestedBy)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(
        ['anonymized', b.key].sort((x, y) =>
          String(x).localeCompare(String(y)),
        ),
      );
    },
  );

  section(
    'reports',
    async () => {
      const base = {
        exporter: 'test-items',
        format: 'csv',
        timezone: 'UTC',
        schedule: { every: 'daily' as const, hour: 8 },
        recipients: [],
        nextRunAt: new Date(),
      };
      await inTenant(() =>
        db.insert(reportSchedules).values([
          { ...base, owner: a.key, name: 'A report' },
          { ...base, owner: b.key, name: 'B report' },
        ]),
      );
    },
    async () => {
      expect((await exported(a.id, 'reports')).map((r) => r.name)).toEqual([
        'A report',
      ]);
    },
    async () => {
      const rows = await inTenant(() => db.select().from(reportSchedules));
      expect(rows.map((r) => r.owner)).toEqual([b.key]);
    },
  );

  section(
    'record-schedules',
    async () => {
      const base = {
        target: 'test-items',
        template: {},
        rrule: 'FREQ=DAILY',
        startDate: '2026-01-01',
        time: '09:00',
        timezone: 'UTC',
      };
      await inTenant(() =>
        db.insert(recordSchedules).values([
          { ...base, owner: a.key, name: 'A schedule' },
          { ...base, owner: b.key, name: 'B schedule' },
        ]),
      );
    },
    async () => {
      expect(
        (await exported(a.id, 'record-schedules')).map((r) => r.name),
      ).toEqual(['A schedule']);
    },
    async () => {
      const rows = await inTenant(() => db.select().from(recordSchedules));
      expect(rows.map((r) => r.owner)).toEqual([b.key]);
    },
  );

  section(
    'notifications',
    async () => {
      await inTenant(() =>
        db.insert(notifications).values([
          { recipient: a.key, type: 't' },
          { recipient: b.key, type: 't' },
        ]),
      );
      await inTenant(() =>
        db.insert(recordSubscriptions).values([
          { subject: 'TestItem', recordId: 'x', subscriber: a.key },
          { subject: 'TestItem', recordId: 'x', subscriber: b.key },
        ]),
      );
      await inNone(async () => {
        await db
          .insert(notificationPreferences)
          .values([{ recipient: a.key }, { recipient: b.key }]);
        await db.insert(pushDevices).values([
          {
            userId: a.id,
            name: 'A phone',
            endpoint: `https://push/${uuid()}`,
            p256dh: 'k',
            auth: 's',
          },
          {
            userId: b.id,
            name: 'B phone',
            endpoint: `https://push/${uuid()}`,
            p256dh: 'k',
            auth: 's',
          },
        ]);
      });
    },
    async () => {
      const rows = await exported(a.id, 'notifications');
      expect(
        rows
          .map((r) => r.kind)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['device', 'notification', 'preferences', 'subscription']);
      // The keys that reach the device stay out.
      expect(rows.find((r) => r.kind === 'device')).not.toHaveProperty('auth');
    },
    async () => {
      expect(
        await inTenant(() => db.select().from(notifications)),
      ).toHaveLength(1);
      expect(
        await inTenant(() => db.select().from(recordSubscriptions)),
      ).toHaveLength(1);
      expect(
        await inNone(() =>
          db
            .select()
            .from(notificationPreferences)
            .where(inArray(notificationPreferences.recipient, [a.key, b.key])),
        ),
      ).toHaveLength(1);
      expect(
        await inNone(() =>
          db
            .select()
            .from(pushDevices)
            .where(inArray(pushDevices.userId, [a.id, b.id])),
        ),
      ).toHaveLength(1);
    },
  );

  section(
    'messaging',
    async () => {
      await inNone(async () => {
        await db.insert(messagingDevices).values([
          {
            userId: a.id,
            platform: 'ios',
            name: 'A',
            token: 't1',
            tokenIndex: 'i1',
          },
          {
            userId: b.id,
            platform: 'ios',
            name: 'B',
            token: 't2',
            tokenIndex: 'i2',
          },
        ]);
        await db.insert(phoneNumbers).values([
          { userId: a.id, phone: '+4915100000001', phoneIndex: 'p1' },
          { userId: b.id, phone: '+4915100000002', phoneIndex: 'p2' },
        ]);
      });
    },
    async () => {
      const rows = await exported(a.id, 'messaging');
      expect(
        rows
          .map((r) => r.kind)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['device', 'phone']);
      expect(rows.find((r) => r.kind === 'device')).not.toHaveProperty('token');
    },
    async () => {
      const left = await inNone(async () => [
        await db
          .select()
          .from(messagingDevices)
          .where(inArray(messagingDevices.userId, [a.id, b.id])),
        await db
          .select()
          .from(phoneNumbers)
          .where(inArray(phoneNumbers.userId, [a.id, b.id])),
      ]);
      expect(left.map((rows) => rows.map((r) => r.userId))).toEqual([
        [b.id],
        [b.id],
      ]);
      // oxlint-disable-next-line typescript/unbound-method
      const forgot = vi.mocked(app.get(MessagingService).forgetCode);
      expect(forgot).toHaveBeenCalledWith(a.id);
    },
  );

  section(
    'mail-deliverability',
    async () => {
      const emails = await inNone(() =>
        db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, [a.id, b.id])),
      );
      await inNone(async () => {
        for (const { email } of emails) {
          const address = normalizeAddress(email);
          await db
            .insert(mailSuppressions)
            .values({ address, reason: 'hard_bounce', source: 'test' });
          await db.insert(mailEvents).values({
            provider: 'test',
            eventId: uuid(),
            type: 'bounce',
            address,
            occurredAt: new Date(),
          });
        }
      });
    },
    async () => {
      const rows = await exported(a.id, 'mail-deliverability');
      expect(
        rows
          .map((r) => r.kind)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['event', 'suppression']);
    },
    async () => {
      const left = await inNone(() => db.select().from(mailSuppressions));
      const [bMail] = await inNone(() =>
        db.select({ email: users.email }).from(users).where(eq(users.id, b.id)),
      );
      expect(left.map((r) => r.address)).toContain(
        normalizeAddress(bMail!.email),
      );
      const [aMail] = await inNone(() =>
        db.select({ email: users.email }).from(users).where(eq(users.id, a.id)),
      );
      expect(left.map((r) => r.address)).not.toContain(
        normalizeAddress(aMail!.email),
      );
      expect(
        (await inNone(() => db.select().from(mailEvents))).map(
          (r) => r.address,
        ),
      ).not.toContain(normalizeAddress(aMail!.email));
    },
  );

  section(
    'settings',
    async () => {
      await inTenant(() =>
        db.insert(settingOverrides).values([
          {
            key: 'ui.theme',
            scope: 'user',
            scopeId: a.key,
            value: 'dark',
            updatedBy: a.key,
          },
          {
            key: 'ui.theme',
            scope: 'user',
            scopeId: b.key,
            value: 'light',
            updatedBy: b.key,
          },
        ]),
      );
    },
    async () => {
      expect((await exported(a.id, 'settings')).map((r) => r.value)).toEqual([
        'dark',
      ]);
    },
    async () => {
      const rows = await inTenant(() => db.select().from(settingOverrides));
      expect(rows.map((r) => r.scopeId)).toEqual([b.key]);
    },
  );

  section(
    'shares',
    async () => {
      const base = {
        subject: 'TestItem',
        fields: ['title'],
        expiresAt: new Date(Date.now() + 86_400_000),
      };
      await inTenant(() =>
        db.insert(recordShares).values([
          { ...base, recordId: uuid(), tokenHash: uuid(), createdBy: a.key },
          { ...base, recordId: uuid(), tokenHash: uuid(), createdBy: b.key },
        ]),
      );
    },
    async () => {
      const rows = await exported(a.id, 'shares');
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('tokenHash');
    },
    async () => {
      const rows = await inTenant(() => db.select().from(recordShares));
      const mine = rows.find((r) => r.createdBy === 'anonymous')!;
      expect(mine.revokedAt).not.toBeNull();
      const theirs = rows.find((r) => r.createdBy === b.key)!;
      expect(theirs.revokedAt).toBeNull();
    },
  );

  section(
    'acknowledgments',
    async () => {
      const base = {
        subject: 'TestItem',
        recordId: uuid(),
        version: 1,
        requestedBy: b.key,
      };
      await inTenant(() =>
        db.insert(recordAcknowledgments).values([
          { ...base, recipient: a.key },
          { ...base, recipient: b.key },
        ]),
      );
    },
    async () => {
      expect(await exported(a.id, 'acknowledgments')).toHaveLength(1);
    },
    async () => {
      const rows = await inTenant(() =>
        db.select().from(recordAcknowledgments),
      );
      expect(rows.map((r) => r.recipient)).toEqual([b.key]);
    },
  );

  section(
    'ai',
    async () => {
      const base = {
        source: 'test-items',
        subject: 'TestItem',
        recordId: uuid(),
        task: 'summary',
        promptVersion: '1',
        status: 'completed' as const,
      };
      await inTenant(() =>
        db.insert(aiRuns).values([
          { ...base, requestedBy: a.key },
          { ...base, recordId: uuid(), requestedBy: b.key },
        ]),
      );
    },
    async () => {
      expect(await exported(a.id, 'ai')).toHaveLength(1);
    },
    async () => {
      const rows = await inTenant(() => db.select().from(aiRuns));
      expect(
        rows
          .map((r) => r.requestedBy)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(
        ['anonymized', b.key].sort((x, y) =>
          String(x).localeCompare(String(y)),
        ),
      );
    },
  );

  section(
    'approvals',
    async () => {
      const request = (requester: string, name: string) => ({
        subject: 'TestItem',
        recordId: uuid(),
        action: 'publish',
        requester,
        requesterName: name,
        title: name,
        payload: {},
        policy: {} as never,
        policyVersion: 0,
      });
      const [mine, theirs] = await inTenant(() =>
        db
          .insert(approvalRequests)
          .values([request(a.key, 'Ada'), request(b.key, 'Bob')])
          .returning(),
      );
      await inTenant(async () => {
        await db.insert(approvalAssignments).values([
          {
            requestId: theirs!.id,
            round: 0,
            stage: 0,
            approverId: a.id,
            status: 'approved',
            decidedBy: a.id,
            decidedByName: 'Ada',
          },
          {
            requestId: mine!.id,
            round: 0,
            stage: 0,
            approverId: b.id,
            status: 'approved',
            decidedBy: b.id,
            decidedByName: 'Bob',
          },
        ]);
        await db.insert(approvalDelegations).values({
          fromUserId: a.id,
          toUserId: b.id,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 1000),
        });
        await db.insert(approvalEvents).values([
          {
            requestId: mine!.id,
            type: 'requested',
            actor: a.key,
            actorName: 'Ada',
            round: 0,
          },
          {
            requestId: theirs!.id,
            type: 'requested',
            actor: b.key,
            actorName: 'Bob',
            round: 0,
          },
        ]);
      });
    },
    async () => {
      const rows = await exported(a.id, 'approvals');
      expect(
        rows
          .map((r) => r.kind)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['decision', 'delegation', 'request']);
    },
    async () => {
      // oxlint-disable-next-line typescript/unbound-method
      expect(vi.mocked(app.get(ApprovalEngine).release)).toHaveBeenCalledWith(
        a.id,
        expect.objectContaining({ kind: 'system' }),
      );
      const requests = await inTenant(() => db.select().from(approvalRequests));
      expect(
        requests
          .map((r) => r.requesterName)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['Bob', 'Deleted user']);
      const decisions = await inTenant(() =>
        db.select().from(approvalAssignments),
      );
      expect(
        decisions
          .map((r) => r.decidedByName)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['Bob', 'Deleted user']);
      const events = await inTenant(() => db.select().from(approvalEvents));
      expect(
        events
          .map((r) => r.actorName)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(
        ['Ada', 'Bob']
          .map((n) => (n === 'Ada' ? 'Deleted user' : n))
          .sort((x, y) => String(x).localeCompare(String(y))),
      );
    },
  );

  section(
    'avatar',
    async () => {
      const disk = app.get(StorageDisk);
      await inNone(async () => {
        await db.insert(userAvatars).values([
          { userId: a.id, key: `accounts/${a.id}/avatar/one.png` },
          { userId: b.id, key: `accounts/${b.id}/avatar/one.png` },
        ]);
      });
      await disk.put(`accounts/${a.id}/avatar/one.png`, Buffer.from('a'));
      await disk.put(`accounts/${a.id}/avatar/orphan.png`, Buffer.from('o'));
      await disk.put(`accounts/${b.id}/avatar/one.png`, Buffer.from('b'));
    },
    async () => {
      const rows = await exported(a.id, 'avatar');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.avatarUrl).toContain(`/v1/people/${a.id}/avatar`);
    },
    async () => {
      const left = await inNone(() =>
        db
          .select()
          .from(userAvatars)
          .where(inArray(userAvatars.userId, [a.id, b.id])),
      );
      expect(left.map((r) => r.userId)).toEqual([b.id]);
      // The files go after the erase commits (modules/storage's
      // `account-files` section, through the outbox's relay).
      const disk = app.get(StorageDisk);
      await vi.waitFor(
        async () => {
          const keys: string[] = [];
          for await (const entry of disk.listAll({ prefix: 'accounts/' }))
            keys.push(entry.key);
          expect(
            keys.filter((k) => k.startsWith(`accounts/${a.id}/avatar/`)),
          ).toEqual([]);
          expect(keys).toContain(`accounts/${b.id}/avatar/one.png`);
        },
        { timeout: 10_000 },
      );
    },
  );

  it("exports each section with the person's rows only", async () => {
    for (const seed of Object.values(seeds)) await seed();
    for (const [name, { before }] of Object.entries(checks)) {
      await before().catch((error: unknown) => {
        throw new Error(`export of ${name}: ${String(error)}`);
      });
    }
  });

  it('shows the roles and organizational units of the person', async () => {
    const { unitId, worker, lead } = await unitWithLead(app, team);
    expect((await exported(team.editor.id, 'roles')).map((r) => r.key)).toEqual(
      ['editor'],
    );
    expect(await exported(team.nobody.id, 'roles')).toEqual([]);
    expect(
      (await exported(worker.id, 'organizational-units')).map((r) => [
        r.id,
        r.role,
      ]),
    ).toEqual([[unitId, 'member']]);
    expect(
      (await exported(lead.id, 'organizational-units')).map((r) => r.role),
    ).toEqual(['lead']);
    expect(await exported(team.nobody.id, 'organizational-units')).toEqual([]);
  });

  it('erases or anonymises the person in every section, and no one else', async () => {
    await erase(a.id);
    for (const [name, { after }] of Object.entries(checks)) {
      await after().catch((error: unknown) => {
        throw new Error(`erase of ${name}: ${String(error)}`);
      });
    }
  });
});
