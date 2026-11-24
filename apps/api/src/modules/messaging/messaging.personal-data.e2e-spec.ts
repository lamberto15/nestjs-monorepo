import { MessagingRepository } from './messaging.repository.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { inArray } from 'drizzle-orm';
import { MessagingPersonalData } from './messaging.personal-data.js';
import { MessagingService } from './messaging.service.js';
import { messagingDevices, phoneNumbers } from './messaging.tables.js';
import { personalDataSection } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-messaging-${process.pid}-${Date.now()}`,
  });
});

/** The `messaging` section (messaging.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection(
  'messaging',
  [
    MessagingPersonalData,
    MessagingRepository,
    {
      provide: EncryptionService,
      useValue: { decrypt: (_c: unknown, v: string) => v },
    },
    { provide: MessagingService, useValue: { forgetCode: vi.fn() } },
  ],
  {
    seed: async (c) => {
      await c.inNone(async () => {
        await c.db.insert(messagingDevices).values([
          {
            userId: c.a.id,
            platform: 'ios',
            name: 'A',
            token: 't1',
            tokenIndex: 'i1',
          },
          {
            userId: c.b.id,
            platform: 'ios',
            name: 'B',
            token: 't2',
            tokenIndex: 'i2',
          },
        ]);
        await c.db.insert(phoneNumbers).values([
          { userId: c.a.id, phone: '+4915100000001', phoneIndex: 'p1' },
          { userId: c.b.id, phone: '+4915100000002', phoneIndex: 'p2' },
        ]);
      });
    },
    exported: async (c) => {
      const rows = await c.exported(c.a.id, 'messaging');
      expect(
        rows
          .map((r) => r.kind)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['device', 'phone']);
      expect(rows.find((r) => r.kind === 'device')).not.toHaveProperty('token');
    },
    erased: async (c) => {
      const left = await c.inNone(async () => [
        await c.db
          .select()
          .from(messagingDevices)
          .where(inArray(messagingDevices.userId, [c.a.id, c.b.id])),
        await c.db
          .select()
          .from(phoneNumbers)
          .where(inArray(phoneNumbers.userId, [c.a.id, c.b.id])),
      ]);
      expect(left.map((rows) => rows.map((r) => r.userId))).toEqual([
        [c.b.id],
        [c.b.id],
      ]);
      // oxlint-disable-next-line typescript/unbound-method
      const forgot = vi.mocked(c.app.get(MessagingService).forgetCode);
      expect(forgot).toHaveBeenCalledWith(c.a.id);
    },
  },
);
