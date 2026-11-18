import { randomUUID } from 'node:crypto';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { SharedIdempotencyModule } from '../src/core/idempotency/idempotency.module.js';
import { SharedOutboxModule } from '../src/core/outbox/outbox.module.js';
import { SecretsModule } from '../src/core/secrets/secrets.module.js';
import { Tenancy } from '../src/core/tenancy/tenancy.service.js';
import { systemPrincipal } from '../src/iam/auth/principal.js';
import { ListsModule } from '../src/modules/lists/lists.module.js';
import { Records } from '../src/modules/records/records.service.js';
import { SearchModule } from '../src/modules/search/search.module.js';
import { accessModules, member, tenantWithAdmin } from './access.js';

/**
 * What an e2e test of records boots besides its test items
 * (`testItemsModule()`, test/fixtures/test-items): the principals and
 * access, idempotency, the outbox (domain events, the relay), the list
 * descriptions and the search. Set SCHEDULER=off and IDEMPOTENCY=optional
 * in `vi.hoisted`.
 */
export const testItemModules = () => [
  ...accessModules(),
  SecretsModule,
  SharedIdempotencyModule,
  SharedOutboxModule,
  ListsModule,
  SearchModule,
];

export type Headers = Record<string, string>;
export interface Member {
  id: string;
  headers: Headers;
}

/**
 * A tenant with its seed roles and the members a records test acts as:
 * `admin`, two editors (`editor`, `other`: each their own records), a
 * `viewer` (reads every record), `nobody` (no role).
 */
export async function recordsTenant(app: NestNodeApplication) {
  const { tenantId, admin } = await tenantWithAdmin(app);
  const [editor, other, viewer, nobody] = await Promise.all([
    member(app, tenantId, ['editor']),
    member(app, tenantId, ['editor']),
    member(app, tenantId, ['viewer']),
    member(app, tenantId, []),
  ]);
  return { tenantId, admin, editor, other, viewer, nobody };
}

/**
 * An organizational unit with an editor in it (their records are the
 * unit's) and a `unit-lead` leading it (reads the unit's records).
 */
export async function unitWithLead(
  app: NestNodeApplication,
  { tenantId, admin }: { tenantId: string; admin: Member },
) {
  const unit = await app.inject({
    method: 'POST',
    url: '/v1/access/organizational-units',
    headers: admin.headers,
    payload: { type: 'team', name: `Team ${randomUUID().slice(0, 6)}` },
  });
  if (unit.statusCode !== 201) throw new Error(unit.body);
  const unitId = unit.json<{ id: string }>().id;
  const [worker, lead] = await Promise.all([
    member(app, tenantId, ['editor']),
    member(app, tenantId, ['unit-lead']),
  ]);
  for (const [userId, role] of [
    [worker.id, 'member'],
    [lead.id, 'lead'],
  ]) {
    const added = await app.inject({
      method: 'POST',
      url: `/v1/access/organizational-units/${unitId}/members`,
      headers: admin.headers,
      payload: { userId, role },
    });
    if (added.statusCode >= 300) throw new Error(added.body);
  }
  return { unitId, worker, lead };
}

/** A test item of the caller's (POST /v1/test-items), as answered: 201 or it throws. */
export async function createTestItem(
  app: NestNodeApplication,
  headers: Headers,
  body: object = {},
) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/test-items',
    headers,
    payload: { title: `Item ${randomUUID().slice(0, 6)}`, ...body },
  });
  if (response.statusCode !== 201) {
    throw new Error(
      `POST /v1/test-items: ${response.statusCode} ${response.body}`,
    );
  }
  return response.json<Record<string, unknown> & { id: string }>();
}

/**
 * What a merge tells the add-ons once it moved `fromId` into `toId`, in its
 * transaction (RecordStore.merged, which modules/merge calls): each
 * extension's `merged` hook moves what it keeps about the duplicate. An
 * add-on's test of its hook calls this, without the merge module, so either
 * can be removed alone.
 */
export async function mergeTestItems(
  app: NestNodeApplication,
  tenantId: string,
  fromId: string,
  toId: string,
) {
  const { store } = app.get(Records).of('TestItem');
  const by = systemPrincipal({ key: 'test-merge', label: 'Test merge' });
  await app.get(Tenancy).run(tenantId, async () => {
    const from = await store.findOne(fromId);
    const to = await store.findOne(toId);
    await store.merged(by, from, to);
  });
}
