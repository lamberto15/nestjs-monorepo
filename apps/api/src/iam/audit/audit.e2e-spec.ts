import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import { authModules } from '../../../test/auth.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { AuditRetentionJob } from './audit-retention.job.js';
import { AuditService } from './audit.service.js';
import { auditLog } from './audit.tables.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.AUDIT_RETENTION_DAYS = '30';
});

describe('the audit log (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let tenancy: Tenancy;
  let audit: AuditService;

  beforeAll(async () => {
    app = await bootModules(...authModules());
    db = app.get(getDrizzleToken());
    tenancy = app.get(Tenancy);
    audit = app.get(AuditService);
  });
  afterAll(async () => {
    await app.close();
  });

  const actions = (tenantId: string | null) =>
    tenancy.run(tenantId, async () =>
      (await db.select().from(auditLog)).map((row) => row.action).sort(),
    );

  it('records in the tenant of the work, labelled with the actor', async () => {
    const { id } = await tenancy.create({ slug: 'audited', name: 'A' });
    const client = {
      kind: 'client' as const,
      id: 'c1',
      name: 'Shop',
      tenantId: id,
    };
    await tenancy.run(id, () =>
      audit.record(client, {
        action: 'thing.done',
        targetType: 'thing',
        targetId: 't1',
      }),
    );
    const [row] = await tenancy.run(id, () =>
      db.select().from(auditLog).where(eq(auditLog.action, 'thing.done')),
    );
    expect(row).toMatchObject({
      tenantId: id,
      actor: 'client:c1',
      actorLabel: 'Shop',
      targetType: 'thing',
      targetId: 't1',
    });
  });

  it('prunes old entries per tenant, deactivated ones too, and outside every tenant, recording each', async () => {
    const live = (await tenancy.create({ slug: 'kept', name: 'K' })).id;
    const closed = (await tenancy.create({ slug: 'closed', name: 'C' })).id;
    const old = new Date(Date.now() - 31 * 86_400_000);
    for (const tenantId of [live, closed, null]) {
      await tenancy.run(tenantId, () =>
        db.insert(auditLog).values([
          { actor: 'anonymous', actorLabel: 'x', action: 'old', at: old },
          { actor: 'anonymous', actorLabel: 'x', action: 'recent' },
        ]),
      );
    }
    await db
      .update(tenants)
      .set({ active: false })
      .where(eq(tenants.id, closed));
    const deleted = await app.get(AuditRetentionJob).run();
    expect(deleted).toBeGreaterThanOrEqual(3);
    for (const tenantId of [live, closed, null]) {
      expect(await actions(tenantId)).toEqual(
        expect.arrayContaining(['audit.pruned', 'recent']),
      );
      expect(await actions(tenantId)).not.toContain('old');
    }
    const [pruned] = await tenancy.run(live, () =>
      db.select().from(auditLog).where(eq(auditLog.action, 'audit.pruned')),
    );
    expect(pruned).toMatchObject({
      actor: 'system:audit-retention',
      actorLabel: 'System: Audit retention',
      details: { deleted: 1, days: 30 },
    });
  });
});
