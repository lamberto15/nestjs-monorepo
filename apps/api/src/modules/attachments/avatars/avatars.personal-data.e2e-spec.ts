import { AvatarsPersonalData } from './avatars.personal-data.js';
import { userAvatars } from './avatars.tables.js';
import { StorageDisk } from '@nestjs/storage';
import { inArray } from 'drizzle-orm';
import { personalDataSection } from '../../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-avatar-${process.pid}-${Date.now()}`,
  });
});

/** The `avatar` section (avatars.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('avatar', [AvatarsPersonalData], {
  seed: async (c) => {
    const disk = c.app.get(StorageDisk);
    await c.inNone(async () => {
      await c.db.insert(userAvatars).values([
        { userId: c.a.id, key: `accounts/${c.a.id}/avatar/one.png` },
        { userId: c.b.id, key: `accounts/${c.b.id}/avatar/one.png` },
      ]);
    });
    await disk.put(`accounts/${c.a.id}/avatar/one.png`, Buffer.from('a'));
    await disk.put(`accounts/${c.a.id}/avatar/orphan.png`, Buffer.from('o'));
    await disk.put(`accounts/${c.b.id}/avatar/one.png`, Buffer.from('b'));
  },
  exported: async (c) => {
    const rows = await c.exported(c.a.id, 'avatar');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.avatarUrl).toContain(`/v1/people/${c.a.id}/avatar`);
  },
  erased: async (c) => {
    const left = await c.inNone(() =>
      c.db
        .select()
        .from(userAvatars)
        .where(inArray(userAvatars.userId, [c.a.id, c.b.id])),
    );
    expect(left.map((r) => r.userId)).toEqual([c.b.id]);
    // The files go after the erase commits (modules/storage's
    // `account-files` section, through the outbox's relay).
    const disk = c.app.get(StorageDisk);
    await vi.waitFor(
      async () => {
        const keys: string[] = [];
        for await (const entry of disk.listAll({ prefix: 'accounts/' }))
          keys.push(entry.key);
        expect(
          keys.filter((k) => k.startsWith(`accounts/${c.a.id}/avatar/`)),
        ).toEqual([]);
        expect(keys).toContain(`accounts/${c.b.id}/avatar/one.png`);
      },
      { timeout: 10_000 },
    );
  },
});
