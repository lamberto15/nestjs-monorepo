import { normalizeAddress } from '../../core/mail/mail-suppression.js';
import { users } from '../../iam/auth/auth.tables.js';
import { eq, inArray } from 'drizzle-orm';
import { DeliverabilityPersonalData } from './deliverability.personal-data.js';
import { mailEvents, mailSuppressions } from './deliverability.tables.js';
import { personalDataSection, uuid } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-mail-deliverability-${process.pid}-${Date.now()}`,
  });
});

/** The `mail-deliverability` section (deliverability.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('mail-deliverability', [DeliverabilityPersonalData], {
  seed: async (c) => {
    const emails = await c.inNone(() =>
      c.db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, [c.a.id, c.b.id])),
    );
    await c.inNone(async () => {
      for (const { email } of emails) {
        const address = normalizeAddress(email);
        await c.db
          .insert(mailSuppressions)
          .values({ address, reason: 'hard_bounce', source: 'test' });
        await c.db.insert(mailEvents).values({
          provider: 'test',
          eventId: uuid(),
          type: 'bounce',
          address,
          occurredAt: new Date(),
        });
      }
    });
  },
  exported: async (c) => {
    const rows = await c.exported(c.a.id, 'mail-deliverability');
    expect(
      rows
        .map((r) => r.kind)
        .sort((x, y) => String(x).localeCompare(String(y))),
    ).toEqual(['event', 'suppression']);
  },
  erased: async (c) => {
    const left = await c.inNone(() => c.db.select().from(mailSuppressions));
    const [bMail] = await c.inNone(() =>
      c.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, c.b.id)),
    );
    expect(left.map((r) => r.address)).toContain(
      normalizeAddress(bMail!.email),
    );
    const [aMail] = await c.inNone(() =>
      c.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, c.a.id)),
    );
    expect(left.map((r) => r.address)).not.toContain(
      normalizeAddress(aMail!.email),
    );
    expect(
      (await c.inNone(() => c.db.select().from(mailEvents))).map(
        (r) => r.address,
      ),
    ).not.toContain(normalizeAddress(aMail!.email));
  },
});
