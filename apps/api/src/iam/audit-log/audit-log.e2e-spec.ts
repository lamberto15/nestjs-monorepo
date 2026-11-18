import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../audit/audit.service.js';
import { auditLog } from '../audit/audit.tables.js';
import { AuditLogModule } from './audit-log.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-audit-log-${process.pid}-${Date.now()}`;
});

type Headers = Record<string, string>;
interface Page {
  items: Record<string, unknown>[];
  nextCursor: string | null;
}

describe('the audit pages (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let otherTenantId: string;
  let admin: Headers;
  let editor: Headers;

  beforeAll(async () => {
    app = await bootModules(...accessModules(), AuditLogModule);
    const tenant = await tenantWithAdmin(app);
    tenantId = tenant.tenantId;
    admin = tenant.admin.headers;
    editor = (await member(app, tenantId, ['editor'])).headers;
    otherTenantId = (await tenantWithAdmin(app)).tenantId;
    const tenancy = app.get(Tenancy);
    const db = app.get<Database>(getDrizzleToken());
    const audit = app.get(AuditService);
    const user = { kind: 'client' as const, id: 'c1', name: 'Shop', tenantId };
    await tenancy.run(tenantId, async () => {
      await audit.record(user, {
        action: 'note.created',
        targetType: 'note',
        targetId: 'n1',
      });
      await audit.record(user, { action: 'invoice.created' });
      await db.insert(auditLog).values([
        {
          actor: 'user:u1',
          actorLabel: 'ada@example.com',
          action: 'member.signed-in',
          details: {
            method: 'password',
            via: 'token',
            userAgent: 'Chrome on macOS',
          },
          ip: '10.0.0.1',
        },
        {
          actor: 'user:u1',
          actorLabel: 'ada@example.com',
          action: 'member.sign-in-failed',
          details: { method: 'password' },
          ip: '10.0.0.2',
        },
        {
          actor: 'user:u2',
          actorLabel: 'bob@example.com',
          action: 'member.signed-in',
          details: { method: 'oidc:google' },
        },
      ]);
    });
    await tenancy.run(otherTenantId, () =>
      audit.record(user, { action: 'secret.created' }),
    );
  });
  afterAll(() => app?.close());

  const get = (url: string, headers: Headers = admin) =>
    app.inject({ method: 'GET', url, headers });
  const page = async (url: string) => {
    const response = await get(url);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<Page>();
  };

  it("lists the log newest first, filtered, with the actor named, and only the tenant's", async () => {
    const all = await page('/v1/access/audit?limit=100');
    const actions = all.items.map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining(['note.created', 'invoice.created']),
    );
    expect(actions).not.toContain('secret.created');
    expect(all.items[0]).toHaveProperty('actorName');

    expect(
      (await page('/v1/access/audit?action.startsWith=note.')).items.map(
        (entry) => entry.action,
      ),
    ).toEqual(['note.created']);
    expect(
      (await page('/v1/access/audit?actor=client:c1&targetId=n1')).items,
    ).toHaveLength(1);
    // By name, as the entry stored it.
    expect(
      (
        await page(
          '/v1/access/audit?actorLabel.contains=shop&action.startsWith=invoice',
        )
      ).items,
    ).toHaveLength(1);
    expect(
      (await page('/v1/access/audit?action.startsWith=note.&fields=action'))
        .items[0],
    ).toEqual({ id: expect.any(String), action: 'note.created' });

    const first = await page('/v1/access/audit?limit=1');
    expect(first.nextCursor).toBeTruthy();
    expect(
      (await page(`/v1/access/audit?limit=1&cursor=${first.nextCursor}`))
        .items[0]!.id,
    ).not.toBe(first.items[0]!.id);
  });

  it("lists the tenant's sign-ins only, by user, method and result", async () => {
    const all = await page('/v1/access/sign-ins');
    expect(all.items).toHaveLength(3);
    expect(all.items.find((entry) => entry.ip === '10.0.0.1')).toMatchObject({
      user: 'user:u1',
      userLabel: 'ada@example.com',
      result: 'success',
      method: 'password',
      via: 'token',
      userAgent: 'Chrome on macOS',
    });
    expect(
      (await page('/v1/access/sign-ins?result=failure')).items,
    ).toMatchObject([{ result: 'failure', ip: '10.0.0.2' }]);
    expect(
      (await page('/v1/access/sign-ins?method.startsWith=oidc:')).items,
    ).toMatchObject([
      { user: 'user:u2', result: 'success', method: 'oidc:google' },
    ]);
    expect((await page('/v1/access/sign-ins?user=user:u1')).items).toHaveLength(
      2,
    );
    expect((await get('/v1/access/sign-ins?result=maybe')).statusCode).toBe(
      400,
    );
  });

  it('needs Access.readAudit', async () => {
    for (const url of ['/v1/access/audit', '/v1/access/sign-ins']) {
      expect((await get(url, editor)).statusCode).toBe(403);
      expect((await get(url, {})).statusCode).toBe(401);
    }
  });
});
