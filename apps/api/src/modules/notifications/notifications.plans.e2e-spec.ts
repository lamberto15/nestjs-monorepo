import type { NestNodeApplication } from '@nestjs/platform-node';
import pg from 'pg';
import { accessModules, tenantWithAdmin } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { captured, fullScans } from '../../../test/query-plans.js';
import { SharedOutboxModule } from '../../core/outbox/outbox.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { SecretsModule } from '../../core/secrets/secrets.module.js';
import { NotificationsModule } from './notifications.module.js';
import { NotificationRetentionJob } from './notifications.retention.job.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-notification-plans-${process.pid}-${Date.now()}`,
  });
});

/**
 * The nightly retention on a large inbox (test/query-plans.ts): each batch
 * finds the old notifications through indexes (read ones by `read_at`, the
 * rest by `created_at`), so it doesn't read the table once per batch.
 */
describe('notification query plans (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      SecretsModule,
      SharedOutboxModule,
      NotificationsModule,
    );
    const { tenantId, admin } = await tenantWithAdmin(app);
    const db = new pg.Client({
      connectionString: process.env.DATABASE_MAINTENANCE_URL,
    });
    await db.connect();
    try {
      // Recent ones, half read: none old enough to go.
      await db.query(
        `insert into notifications (tenant_id, recipient, type, read_at)
         select $1, 'user:' || $2, 'notification.test', case when n % 2 = 0 then now() end
         from generate_series(1, 30000) n`,
        [tenantId, admin.id],
      );
    } finally {
      await db.end();
    }
    const owner = new pg.Client({
      connectionString: process.env.DATABASE_OWNER_URL,
    });
    await owner.connect();
    try {
      await owner.query('vacuum analyze notifications');
    } finally {
      await owner.end();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('finds the old notifications with indexes', async () => {
    const statements = await captured(() =>
      app.get(NotificationRetentionJob).run(),
    );
    expect(statements.length).toBeGreaterThan(0);
    expect(
      await fullScans(
        statements,
        ['notifications'],
        [process.env.DATABASE_URL!, process.env.DATABASE_MAINTENANCE_URL!],
      ),
    ).toEqual([]);
  });
});
