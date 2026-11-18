import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import pg from 'pg';
import { accessModules, tenantWithAdmin } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { captured, fullScans } from '../../../test/query-plans.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { STORAGE_BYTES } from './attachments.quota.js';

/**
 * The storage quota on a large table (test/query-plans.ts): each upload of
 * a tenant with a limit sums its files' sizes, from an index, not the table.
 */
describe('attachment query plans (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;

  beforeAll(async () => {
    app = await bootModules(...accessModules());
    const [mine, other] = await Promise.all([
      tenantWithAdmin(app),
      tenantWithAdmin(app),
    ]);
    tenantId = mine.tenantId;
    const db = new pg.Client({
      connectionString: process.env.DATABASE_MAINTENANCE_URL,
    });
    await db.connect();
    try {
      for (const [tenant, count] of [
        [other.tenantId, 20_000],
        [mine.tenantId, 200],
      ] as const) {
        await db.query(
          `insert into attachments (tenant_id, subject, record_id, key, name, size, content_type, uploaded_by)
           select $1::uuid, 'Widget', $2, $1::text || '/' || n, 'file.txt', n, 'text/plain; charset=utf-8', 'user:x'
           from generate_series(1, $3::int) n`,
          [tenant, randomUUID(), count],
        );
      }
    } finally {
      await db.end();
    }
    const owner = new pg.Client({
      connectionString: process.env.DATABASE_OWNER_URL,
    });
    await owner.connect();
    try {
      await owner.query('vacuum analyze attachments, attachment_versions');
    } finally {
      await owner.end();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sums a tenant’s files with an index', async () => {
    const db = app.get<Database>(getDrizzleToken());
    let bytes = 0;
    const statements = await captured(async () => {
      bytes = await app
        .get(Tenancy)
        .run(tenantId, () => STORAGE_BYTES.count(db));
    });
    // 1 + 2 + … + 200: the tenant's own files only.
    expect(bytes).toBe((200 * 201) / 2);
    expect(
      await fullScans(
        statements,
        ['attachments'],
        [process.env.DATABASE_URL!, process.env.DATABASE_MAINTENANCE_URL!],
      ),
    ).toEqual([]);
  });
});
