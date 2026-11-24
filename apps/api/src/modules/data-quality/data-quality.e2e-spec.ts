import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq } from 'drizzle-orm';
import { member, tenantWithAdmin } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  type Headers,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { RecycleBinPurgeJob } from '../records/recycle-bin.job.js';
import { DataQualityModule } from './data-quality.module.js';
import { DataQualityRetentionJob } from './data-quality.retention.job.js';
import { DataQualityService } from './data-quality.service.js';
import { dataQualityFindings } from './data-quality.tables.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  // The scan's batches run on this process's worker.
  process.env.APP_ROLE = 'all';
  process.env.REDIS_PREFIX = `test-data-quality-${process.pid}-${Date.now()}`;
});

interface Finding {
  id: string;
  recordId: string;
  check: string;
  field: string;
  severity: string;
  detail: Record<string, string | string[]> | null;
}

describe('data quality on test items (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;
  let admin: Headers;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      testItemsModule({
        imports: [
          DataQualityModule.forRecord(TEST_ITEM, {
            recommended: ['body', 'code'],
            duplicates: ['title'],
            rules: [
              {
                name: 'done-has-body',
                expect: "status != 'done' or length(coalesce(body, '')) > 0",
                severity: 'error',
                message: 'A finished item says what was done.',
              },
            ],
          }),
        ],
      }),
    );
  });
  afterAll(async () => {
    await app?.close();
  });
  // Each test its own tenant: findings and scans are per tenant.
  beforeEach(async () => {
    team = await recordsTenant(app);
    admin = team.admin.headers;
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  const item = async (body: Record<string, unknown>) =>
    (await createTestItem(app, admin, body)).id;

  /** Starts a scan and waits for it to complete. */
  const scan = async (headers = admin) => {
    const started = await call('POST', '/v1/data-quality/scans', headers);
    expect(started.statusCode).toBe(202);
    for (let i = 0; i < 200; i++) {
      const summary = (await call('GET', '/v1/data-quality', headers)).json();
      if (summary.lastScan.status === 'completed') return summary;
      expect(summary.lastScan.status).not.toBe('failed');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The scan did not complete.');
  };

  const findings = async (headers: Headers, query = '') => {
    const response = await call(
      'GET',
      `/v1/data-quality/subjects/TestItem/findings${query}`,
      headers,
    );
    expect(response.statusCode).toBe(200);
    return response.json().items as Finding[];
  };

  const key = (f: Finding) => `${f.recordId}:${f.check}:${f.field}`;
  const sorted = (keys: string[]) => keys.sort((a, b) => a.localeCompare(b));

  it('finds empty recommended fields, duplicate titles, broken rules and references to the recycle bin, changing no record', async () => {
    const complete = await item({ title: 'Plan', body: 'Text', code: 'A1' });
    const sparse = await item({ title: ' plan', status: 'done' });
    const parent = await item({ title: 'Parent', body: 'P', code: 'P1' });
    const child = await item({
      title: 'Child',
      body: 'C',
      code: 'C1',
      linkedId: parent,
    });
    expect(
      (await call('DELETE', `/v1/test-items/${parent}`, admin)).statusCode,
    ).toBe(204);

    const done = await scan();
    expect(done.lastScan).toMatchObject({
      status: 'completed',
      total: 3,
      scanned: 3,
      findings: 6,
    });
    expect(done.subjects).toEqual([
      { subject: 'TestItem', errors: 2, suggestions: 4, dismissed: 0 },
    ]);
    const found = await findings(admin);
    expect(sorted(found.map(key))).toEqual(
      sorted([
        `${child}:reference:linkedId`,
        `${complete}:duplicate:title`,
        `${sparse}:duplicate:title`,
        `${sparse}:missing:body`,
        `${sparse}:missing:code`,
        `${sparse}:rule:done-has-body`,
      ]),
    );
    expect(found.find((f) => f.check === 'reference')).toMatchObject({
      severity: 'error',
      detail: { referencedId: parent },
    });
    expect(found.find((f) => f.check === 'rule')).toMatchObject({
      severity: 'error',
      detail: { message: 'A finished item says what was done.' },
    });
    expect(
      found.find((f) => f.recordId === complete && f.check === 'duplicate'),
    ).toMatchObject({
      severity: 'suggestion',
      detail: { duplicateOf: [sparse] },
    });

    // By check, and of one record at its own route.
    expect(await findings(admin, '?check=rule')).toHaveLength(1);
    const ofSparse = await call(
      'GET',
      `/v1/test-items/${sparse}/data-quality`,
      admin,
    );
    expect(sorted(ofSparse.json().items.map(key))).toEqual(
      sorted(found.filter((f) => f.recordId === sparse).map(key)),
    );
    // Not one a caller may not read.
    expect(
      (
        await call(
          'GET',
          `/v1/test-items/${sparse}/data-quality`,
          team.nobody.headers,
        )
      ).statusCode,
    ).toBe(403);

    // No repair: the reference (a `keep` one) is still there.
    const read = await call('GET', `/v1/test-items/${child}`, admin);
    expect(read.json().linkedId).toBe(parent);

    // Another tenant sees none of it.
    const other = await tenantWithAdmin(app);
    const theirs = await call('GET', '/v1/data-quality', other.admin.headers);
    expect(theirs.json().lastScan).toBeNull();
    expect(
      (
        await call(
          'POST',
          `/v1/data-quality/findings/${found[0]!.id}/dismiss`,
          other.admin.headers,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('shows no finding on a field the caller may not read, nor to someone without the permission', async () => {
    const sparse = await item({ title: 'Lonely', status: 'done' });
    await scan();
    const role = await call('POST', '/v1/access/roles', admin, {
      name: `quality-${randomUUID().slice(0, 8)}`,
      permissions: [
        // Every test item, but not its text (the field-level permission).
        { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
        { subject: 'DataQuality', action: 'read', conditions: [] },
      ],
    });
    expect(role.statusCode).toBe(201);
    const limited = await member(app, team.tenantId, [role.json().id]);
    // `body` is hidden: neither its missing check nor the rule that reads it.
    expect((await findings(limited.headers)).map(key)).toEqual([
      `${sparse}:missing:code`,
    ]);
    const summary = await call('GET', '/v1/data-quality', limited.headers);
    expect(summary.json().subjects).toEqual([
      { subject: 'TestItem', errors: 0, suggestions: 1, dismissed: 0 },
    ]);
    const hidden = (await findings(admin)).find((f) => f.field === 'body')!;
    // Reading is not acting, and a hidden finding is no finding.
    for (const url of [
      `/v1/data-quality/findings/${hidden.id}/recheck`,
      '/v1/data-quality/scans',
    ]) {
      expect((await call('POST', url, limited.headers)).statusCode).toBe(403);
    }
    expect(
      (await call('GET', '/v1/data-quality', team.editor.headers)).statusCode,
    ).toBe(403);
  });

  it('shows a duplicate only to who may read the record it duplicates', async () => {
    const role = await call('POST', '/v1/access/roles', admin, {
      name: `own-quality-${randomUUID().slice(0, 8)}`,
      permissions: [
        { subject: 'TestItem', action: 'create', conditions: [] },
        // Their own test items only.
        {
          subject: 'TestItem',
          action: 'read',
          conditions: [{ key: 'mine' }],
        },
        { subject: 'DataQuality', action: 'read', conditions: [] },
      ],
    });
    expect(role.statusCode).toBe(201);
    const owner = await member(app, team.tenantId, [role.json().id]);
    const theirs = (
      await createTestItem(app, owner.headers, {
        title: 'Twin',
        body: 'B',
        code: 'T1',
      })
    ).id;
    const hidden = await item({ title: 'twin', body: 'B', code: 'T2' });
    await scan();
    // The admin reads both: each names the other.
    expect(
      (await findings(admin, '?check=duplicate')).map((f) => [
        f.recordId,
        f.detail,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [theirs, { duplicateOf: [hidden] }],
        [hidden, { duplicateOf: [theirs] }],
      ]),
    );
    // The owner's record duplicates one they may not read: no finding, no id.
    const own = await findings(owner.headers);
    expect(own.filter((f) => f.check === 'duplicate')).toEqual([]);
    expect(JSON.stringify(own)).not.toContain(hidden);
    const summary = await call('GET', '/v1/data-quality', owner.headers);
    expect(summary.json().subjects).toEqual([
      { subject: 'TestItem', errors: 0, suggestions: 0, dismissed: 0 },
    ]);
  });

  it('names in a duplicate only the records the reader may read', async () => {
    const role = await call('POST', '/v1/access/roles', admin, {
      name: `own-quality-${randomUUID().slice(0, 8)}`,
      permissions: [
        { subject: 'TestItem', action: 'create', conditions: [] },
        {
          subject: 'TestItem',
          action: 'read',
          conditions: [{ key: 'mine' }],
        },
        { subject: 'DataQuality', action: 'read', conditions: [] },
        { subject: 'DataQuality', action: 'resolve', conditions: [] },
      ],
    });
    expect(role.statusCode).toBe(201);
    const owner = await member(app, team.tenantId, [role.json().id]);
    const own = (title: string) =>
      createTestItem(app, owner.headers, { title, body: 'B', code: title });
    // Made in this order, so the hidden one is the first other by id.
    const first = (await own('Trio')).id;
    const hidden = await item({ title: 'TRIO', body: 'B', code: 'T0' });
    const second = (await own('trio ')).id;
    await scan();

    const ofFirst = (await findings(admin, '?check=duplicate')).find(
      (f) => f.recordId === first,
    );
    expect(ofFirst!.detail).toEqual({ duplicateOf: [hidden, second] });
    const seen = await findings(owner.headers, '?check=duplicate');
    expect(seen.map((f) => [f.recordId, f.detail])).toEqual(
      expect.arrayContaining([
        [first, { duplicateOf: [second] }],
        [second, { duplicateOf: [first] }],
      ]),
    );
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen)).not.toContain(hidden);
    // A recheck answers it as the list does.
    const rechecked = await call(
      'POST',
      `/v1/data-quality/findings/${seen[0]!.id}/recheck`,
      owner.headers,
    );
    expect(rechecked.statusCode).toBe(200);
    expect(JSON.stringify(rechecked.json())).not.toContain(hidden);
    expect(rechecked.json().finding.detail.duplicateOf).toHaveLength(1);
  });

  it('keeps a dismissed finding dismissed across scans, and a recheck resolves a fixed one', async () => {
    const sparse = await item({ title: 'Sparse' });
    await scan();
    const open = await findings(admin);
    const code = open.find((f) => f.field === 'code')!;
    const body = open.find((f) => f.field === 'body')!;

    const dismissed = await call(
      'POST',
      `/v1/data-quality/findings/${code.id}/dismiss`,
      admin,
    );
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json().dismissedAt).toEqual(expect.any(String));
    expect((await findings(admin)).map((f) => f.id)).toEqual([body.id]);
    expect((await findings(admin, '?dismissed=true')).map((f) => f.id)).toEqual(
      [code.id],
    );
    const audited = await app
      .get(Tenancy)
      .run(team.tenantId, () =>
        app
          .get<Database>(getDrizzleToken())
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, 'data-quality.finding-dismissed')),
      );
    expect(audited).toHaveLength(1);

    // A rescan finds it again: still dismissed.
    const again = await scan();
    expect(again.subjects).toEqual([
      { subject: 'TestItem', errors: 0, suggestions: 1, dismissed: 1 },
    ]);

    // Still empty: the recheck says so.
    const unchanged = await call(
      'POST',
      `/v1/data-quality/findings/${body.id}/recheck`,
      admin,
    );
    expect(unchanged.json()).toMatchObject({
      resolved: false,
      finding: { id: body.id },
    });

    const read = await call('GET', `/v1/test-items/${sparse}`, admin);
    const patched = await call(
      'PATCH',
      `/v1/test-items/${sparse}`,
      { ...admin, 'if-match': read.headers.etag as string },
      { body: 'Now it says something' },
    );
    expect(patched.statusCode).toBe(200);
    const fixed = await call(
      'POST',
      `/v1/data-quality/findings/${body.id}/recheck`,
      admin,
    );
    expect(fixed.json()).toEqual({ resolved: true, finding: null });
    expect(await findings(admin)).toEqual([]);
    expect(
      (
        await call(
          'POST',
          `/v1/data-quality/findings/${body.id}/recheck`,
          admin,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('forgets the findings of a record deleted for good, and runs one scan at a time', async () => {
    const gone = await item({ title: 'Gone' });
    await scan();
    expect(await findings(admin)).not.toEqual([]);
    expect(
      (await call('DELETE', `/v1/test-items/${gone}`, admin)).statusCode,
    ).toBe(204);
    // A record in the recycle bin shows no findings; once purged they are deleted.
    expect(await findings(admin)).toEqual([]);
    const db = app.get<Database>(getDrizzleToken());
    const { testItems } =
      await import('../../../test/fixtures/test-items/test-items.tables.js');
    await app.get(Tenancy).run(team.tenantId, () =>
      db
        .update(testItems)
        .set({ deletedAt: new Date(Date.now() - 90 * 86_400_000) })
        .where(eq(testItems.id, gone)),
    );
    await app.get(RecycleBinPurgeJob).run();
    const { dataQualityFindings } = await import('./data-quality.tables.js');
    const left = await app
      .get(Tenancy)
      .run(team.tenantId, () => db.select().from(dataQualityFindings));
    expect(left).toEqual([]);

    const first = await call('POST', '/v1/data-quality/scans', admin);
    const second = await call('POST', '/v1/data-quality/scans', admin);
    // The first may have finished already; if not, the second waits its turn.
    expect(first.statusCode).toBe(202);
    expect([202, 409]).toContain(second.statusCode);
    if (second.statusCode === 409) {
      expect(second.json().code).toBe('scan_running');
    }
  });

  it('deletes findings no scan found again for DATA_QUALITY_FINDING_RETENTION_DAYS every night, and keeps recent ones', async () => {
    const db = app.get<Database>(getDrizzleToken());
    const inTenant = <T>(work: () => Promise<T>) =>
      app.get(Tenancy).run(team.tenantId, work);
    const now = new Date();
    const finding = (checkedAt: Date) => ({
      subject: 'TestItem',
      recordId: randomUUID(),
      check: 'missing' as const,
      field: 'body',
      severity: 'suggestion' as const,
      checkedAt,
    });
    const [, recent] = await inTenant(() =>
      db
        .insert(dataQualityFindings)
        .values([
          finding(new Date(now.getTime() - 181 * 86_400_000)),
          finding(new Date(now.getTime() - 179 * 86_400_000)),
        ])
        .returning({ id: dataQualityFindings.id }),
    );
    expect(
      await app.get(DataQualityRetentionJob).run(now),
    ).toBeGreaterThanOrEqual(1);
    const left = await inTenant(() =>
      db.select({ id: dataQualityFindings.id }).from(dataQualityFindings),
    );
    expect(left).toEqual([recent]);
  });

  it('queues a batch once: a retried batch queues no second next one', async () => {
    const quality = app.get(DataQualityService);
    const next = {
      tenantId: team.tenantId,
      scanId: randomUUID(),
      subject: 'TestItem',
      after: randomUUID(),
    };
    const first = await quality.queueNext(next);
    const again = await quality.queueNext(next);
    expect(again.id).toBe(first.id);
  });
});
