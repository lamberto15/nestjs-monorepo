import type { NestNodeApplication } from '@nestjs/platform-node';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { AuditLogModule } from '../../iam/audit-log/audit-log.module.js';
import { RecordsModule } from '../records/records.module.js';
import { ListsModule } from './lists.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-lists-${process.pid}-${Date.now()}`;
});

describe('GET /v1/lists/{subject} (e2e)', () => {
  let app: NestNodeApplication;
  let admin: Record<string, string>;
  let editor: Record<string, string>;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      RecordsModule,
      AuditLogModule,
      ListsModule,
    );
    const tenant = await tenantWithAdmin(app);
    admin = tenant.admin.headers;
    editor = (await member(app, tenant.tenantId, ['editor'])).headers;
  });
  afterAll(() => app?.close());

  const get = (subject: string, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: `/v1/lists/${subject}`, headers });

  it("describes the audit pages' lists for whoever holds Access.readAudit", async () => {
    for (const [subject, field] of [
      ['Audit', 'action'],
      ['SignIn', 'method'],
    ] as const) {
      const response = await get(subject, admin);
      expect(response.statusCode, response.body).toBe(200);
      expect(
        response
          .json<{ fields: { name: string }[] }>()
          .fields.map((f) => f.name),
      ).toContain(field);
      expect((await get(subject, editor)).statusCode).toBe(403);
    }
  });
});
