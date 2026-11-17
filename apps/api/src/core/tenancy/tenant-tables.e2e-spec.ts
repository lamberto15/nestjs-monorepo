import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq } from 'drizzle-orm';
import { Client } from 'pg';
import { bootModules } from '../../../test/boot.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { memberships, users } from '../../iam/auth/auth.tables.js';
import { DatabaseModule } from '../database/database.module.js';
import type { Database } from '../database/database.js';
import { rowLevelSecurity } from './row-level-security.js';
import { TenancyModule } from './tenancy.module.js';
import { Tenancy } from './tenancy.service.js';

const codeOf = (error: unknown) =>
  (error as { cause?: { code?: string } }).cause?.code ??
  (error as { code?: string }).code;

/**
 * The two kinds of tables that name a tenant besides tenantTable()'s own:
 * global tables (globalTable(): memberships, api_keys) and tenant tables
 * with rows of no tenant (`nullRows: 'outside'`: audit_log), on the
 * migrated schema, as the app's role; and the check at migrate that tells
 * each from a table that lost its wall.
 */
describe('tables that name a tenant (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let tenancy: Tenancy;
  let a: string;
  let b: string;

  beforeAll(async () => {
    app = await bootModules(DatabaseModule, TenancyModule);
    db = app.get(getDrizzleToken());
    tenancy = app.get(Tenancy);
    a = (await tenancy.create({ slug: 'tt-a', name: 'A' })).id;
    b = (await tenancy.create({ slug: 'tt-b', name: 'B' })).id;
  });
  afterAll(async () => {
    await app.close();
  });

  describe('a global table (globalTable())', () => {
    it('is read and written in any scope, and every insert names its tenant', async () => {
      const [user] = await db
        .insert(users)
        .values({ email: 'global@acme.dev', name: 'G' })
        .returning();
      await tenancy.run(a, () =>
        db.insert(memberships).values({ tenantId: b, userId: user!.id }),
      );
      for (const scope of [a, b, null]) {
        const rows = await tenancy.run(scope, () =>
          db.select().from(memberships).where(eq(memberships.userId, user!.id)),
        );
        expect(rows.map((row) => row.tenantId)).toEqual([b]);
      }
      // No tenant from the context: an insert without one is refused.
      const refused = await tenancy
        .run(a, () =>
          db
            .insert(memberships)
            .values({ userId: user!.id } as typeof memberships.$inferInsert),
        )
        .catch((error: unknown) => error);
      expect(codeOf(refused)).toBe('23502'); // not_null_violation
    });
  });

  describe("a tenant table's rows of no tenant (nullRows: 'outside')", () => {
    const entry = (action: string) => ({
      actor: 'anonymous',
      actorLabel: 'x',
      action,
    });

    it('takes the tenant of the work, or none outside every tenant', async () => {
      const [inA] = await tenancy.run(a, () =>
        db.insert(auditLog).values(entry('in-a')).returning(),
      );
      const [outside] = await tenancy.run(null, () =>
        db.insert(auditLog).values(entry('outside')).returning(),
      );
      expect(inA!.tenantId).toBe(a);
      expect(outside!.tenantId).toBeNull();
    });

    it('shows a tenant its own rows only, and work outside every tenant the rows of none', async () => {
      await tenancy.run(b, () => db.insert(auditLog).values(entry('in-b')));
      const seen = (scope: string | null) =>
        tenancy.run(scope, async () =>
          (await db.select().from(auditLog)).map((row) => row.action).sort(),
        );
      expect(await seen(a)).toEqual(['in-a']);
      expect(await seen(b)).toEqual(['in-b']);
      expect(await seen(null)).toEqual(['outside']);
    });

    it('refuses a tenant writing a row of none, or of another tenant', async () => {
      for (const tenantId of [null, b]) {
        const refused = await tenancy
          .run(a, () =>
            db.insert(auditLog).values({ ...entry('forged'), tenantId }),
          )
          .catch((error: unknown) => error);
        expect(codeOf(refused)).toBe('42501'); // the policy's WITH CHECK
      }
      const refused = await tenancy
        .run(null, () =>
          db.insert(auditLog).values({ ...entry('forged'), tenantId: a }),
        )
        .catch((error: unknown) => error);
      expect(codeOf(refused)).toBe('42501');
    });
  });

  describe('the check at migrate', () => {
    /** Runs `change` as the tables' owner, then the check, and rolls both back. */
    async function checkAfter(change: string) {
      const owner = new Client({
        connectionString: process.env.DATABASE_OWNER_URL,
      });
      await owner.connect();
      try {
        await owner.query('begin');
        if (change) await owner.query(change);
        return await rowLevelSecurity
          .secure(owner, () => {})
          .then(() => 'passed')
          .catch((error: Error) => error.message);
      } finally {
        await owner.query('rollback');
        await owner.end();
      }
    }

    it('passes the migrated schema', async () => {
      expect(await checkAfter('')).toBe('passed');
    }, 60_000);

    it('stops a global table that lost its declaration', async () => {
      expect(
        await checkAfter('drop policy memberships_global on memberships'),
      ).toMatch(/memberships \(missing policy memberships_tenant_select/);
    }, 60_000);

    it("stops a nullRows table's policy loosened by hand", async () => {
      expect(
        await checkAfter(
          'alter policy audit_log_tenant_select on audit_log using (true)',
        ),
      ).toMatch(
        /audit_log \(policy audit_log_tenant_select differs \(using\)\)/,
      );
    }, 60_000);

    it('lets no tenant table pass for a global or a nullRows one', async () => {
      // Its policies stay its own.
      expect(
        await checkAfter(
          'create policy api_clients_global on api_clients for all using (true) with check (true)',
        ),
      ).toMatch(
        /api_clients \(unexpected permissive policy api_clients_tenant_/,
      );
      // Nor a tenant table for a nullRows one.
      expect(
        await checkAfter(
          'alter table api_clients alter column tenant_id drop not null',
        ),
      ).toMatch(/api_clients \(policy api_clients_tenant_\w+ differs/);
    }, 60_000);
  });
});
