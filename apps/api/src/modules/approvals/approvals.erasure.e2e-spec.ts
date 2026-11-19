import { getDrizzleToken } from '@nestjs/drizzle';
import { OutboxRelay } from '@nestjs/outbox';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { WorkflowClient } from '@nestjs/workflows';
import { bootModules } from '../../../test/boot.js';
import { TestItemApprovalEffects } from '../../../test/fixtures/approvals/test-item-approvals.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SharedWorkflowsModule } from '../../core/workflows/workflows.module.js';
import { TenantDeletionJob } from '../../iam/tenants/tenant-deletion.job.js';
import { TenantsModule } from '../../iam/tenants/tenants.module.js';
import { tenantLifecycle } from '../../iam/tenants/tenants.tables.js';
import { approvalWorkflowId } from './approvals.events.js';
import { ApprovalsModule } from './approvals.module.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    OUTBOX_RELAY: 'off',
    IDEMPOTENCY: 'optional',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    OPERATOR_TENANT: `ops-${process.pid}-${Date.now()}`,
    REDIS_PREFIX: `test-approvals-erasure-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  });
});

const DAY = 86_400_000;

describe('approvals: an erased tenant takes its workflows (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      SharedWorkflowsModule,
      TenantsModule,
      testItemsModule({
        imports: [
          ApprovalsModule.forRecord(TEST_ITEM, {
            publish: { label: 'Publish a test item', flag: false },
            archive: { label: 'Archive a test item' },
          }),
          TestItemApprovalEffects,
        ],
      }),
    );
  });
  afterAll(() => app?.close());

  /** A pending request in a tenant of its own, once its workflow waits for the approvers. */
  async function waitingRequest() {
    const team = await recordsTenant(app);
    const item = await createTestItem(app, team.editor.headers);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/test-items/${item.id}/publish`,
      headers: team.editor.headers,
    });
    expect(res.statusCode, res.body).toBe(202);
    const workflowId = approvalWorkflowId(
      res.json<{ approvalId: string }>().approvalId,
    );
    for (let i = 0; i < 150; i++) {
      const instance = await app.get(WorkflowClient).getStatus(workflowId);
      if (instance?.status === 'suspended') {
        return { tenantId: team.tenantId, workflowId };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${workflowId} never waited for its approvers`);
  }

  it("deletes the erased tenant's waiting workflows after the commit, and no other tenant's", async () => {
    const erased = await waitingRequest();
    const kept = await waitingRequest();
    await app.get(Tenancy).run(null, () =>
      app
        .get<Database>(getDrizzleToken())
        .insert(tenantLifecycle)
        .values({
          tenantId: erased.tenantId,
          deletionRequestedAt: new Date(Date.now() - 40 * DAY),
          deletionScheduledFor: new Date(Date.now() - DAY),
        }),
    );

    expect(await app.get(TenantDeletionJob).eraseDue()).toBe(1);
    const workflows = app.get(WorkflowClient);
    // Deleted from the outbox, once the erase committed.
    expect(await workflows.getStatus(erased.workflowId)).not.toBeNull();
    await app.get(OutboxRelay).runOnce();
    await app.get(OutboxRelay).runOnce();

    expect(await workflows.getStatus(erased.workflowId)).toBeNull();
    expect((await workflows.getStatus(kept.workflowId))?.status).toBe(
      'suspended',
    );
  });
});
