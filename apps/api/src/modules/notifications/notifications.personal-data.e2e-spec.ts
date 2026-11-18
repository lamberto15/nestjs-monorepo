import { inArray } from 'drizzle-orm';
import { NotificationsPersonalData } from './notifications.personal-data.js';
import {
  notificationPreferences,
  notifications,
  pushDevices,
  recordSubscriptions,
} from './notifications.tables.js';
import { personalDataSection, uuid } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-notifications-${process.pid}-${Date.now()}`,
  });
});

/** The `notifications` section (notifications.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('notifications', [NotificationsPersonalData], {
  seed: async (c) => {
    await c.inTenant(() =>
      c.db.insert(notifications).values([
        { recipient: c.a.key, type: 't' },
        { recipient: c.b.key, type: 't' },
      ]),
    );
    await c.inTenant(() =>
      c.db.insert(recordSubscriptions).values([
        { subject: 'TestItem', recordId: 'x', subscriber: c.a.key },
        { subject: 'TestItem', recordId: 'x', subscriber: c.b.key },
      ]),
    );
    await c.inNone(async () => {
      await c.db
        .insert(notificationPreferences)
        .values([{ recipient: c.a.key }, { recipient: c.b.key }]);
      await c.db.insert(pushDevices).values([
        {
          userId: c.a.id,
          name: 'A phone',
          endpoint: `https://push/${uuid()}`,
          p256dh: 'k',
          auth: 's',
        },
        {
          userId: c.b.id,
          name: 'B phone',
          endpoint: `https://push/${uuid()}`,
          p256dh: 'k',
          auth: 's',
        },
      ]);
    });
  },
  exported: async (c) => {
    const rows = await c.exported(c.a.id, 'notifications');
    expect(
      rows
        .map((r) => r.kind)
        .sort((x, y) => String(x).localeCompare(String(y))),
    ).toEqual(['device', 'notification', 'preferences', 'subscription']);
    // The keys that reach the device stay out.
    expect(rows.find((r) => r.kind === 'device')).not.toHaveProperty('auth');
  },
  erased: async (c) => {
    expect(
      await c.inTenant(() => c.db.select().from(notifications)),
    ).toHaveLength(1);
    expect(
      await c.inTenant(() => c.db.select().from(recordSubscriptions)),
    ).toHaveLength(1);
    expect(
      await c.inNone(() =>
        c.db
          .select()
          .from(notificationPreferences)
          .where(
            inArray(notificationPreferences.recipient, [c.a.key, c.b.key]),
          ),
      ),
    ).toHaveLength(1);
    expect(
      await c.inNone(() =>
        c.db
          .select()
          .from(pushDevices)
          .where(inArray(pushDevices.userId, [c.a.id, c.b.id])),
      ),
    ).toHaveLength(1);
  },
});
