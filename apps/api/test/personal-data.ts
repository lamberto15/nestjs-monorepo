import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Module, type Provider } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Database } from '../src/core/database/database.js';
import { QueuesModule } from '../src/core/queues/queues.module.js';
import { Tenancy } from '../src/core/tenancy/tenancy.service.js';
import { PersonalDataModule } from '../src/iam/personal-data/personal-data.module.js';
import {
  type PersonalDataBatch,
  PersonalDataService,
} from '../src/iam/personal-data/personal-data.service.js';
import { StorageModule } from '../src/modules/storage/storage.module.js';
import { bootModules } from './boot.js';
import { recordsTenant, testItemModules } from './records.js';

/** Two people of one tenant: A is exported and erased, B must stay as they were. */
export interface Person {
  id: string;
  /** `user:<id>`. */
  key: string;
}

/** What a section's test reaches, once booted. */
export interface SectionContext {
  app: NestNodeApplication;
  db: Database;
  team: Awaited<ReturnType<typeof recordsTenant>>;
  a: Person;
  b: Person;
  /** What `userId`'s export holds in `section`. */
  exported(userId: string, section: string): Promise<Record<string, unknown>[]>;
  inTenant<T>(work: () => Promise<T>): Promise<T>;
  /** In no tenant: the account's own rows. */
  inNone<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * The e2e test of one module's `@PersonalData` section(s), in that module's
 * folder (`<name>.personal-data.e2e-spec.ts`): the section's providers boot
 * with iam/personal-data and the records' test items; `seed` writes rows of
 * A and of B, `exported` checks A's export holds A's rows only, `erased`
 * that A's deletion removed or anonymised A and left B. Set SCHEDULER=off,
 * IDEMPOTENCY=optional, APP_ROLE=all, STORAGE_DRIVER=memory and
 * DATA_ENCRYPTION_KEYS in `vi.hoisted`.
 */
export function personalDataSection(
  name: string,
  providers: Provider[],
  test: {
    seed: (c: SectionContext) => Promise<void>;
    exported: (c: SectionContext) => Promise<void>;
    erased: (c: SectionContext) => Promise<void>;
  },
) {
  describe(`personal data, ${name}: export and erase (e2e)`, () => {
    const c = {} as SectionContext;

    beforeAll(async () => {
      @Module({ providers })
      class SectionModule {}
      c.app = await bootModules(
        ...testItemModules(),
        QueuesModule,
        StorageModule,
        PersonalDataModule,
        SectionModule,
      );
      c.db = c.app.get<Database>(getDrizzleToken());
      c.team = await recordsTenant(c.app);
      c.a = { id: c.team.editor.id, key: `user:${c.team.editor.id}` };
      c.b = { id: c.team.other.id, key: `user:${c.team.other.id}` };
      const tenancy = c.app.get(Tenancy);
      c.inTenant = (work) => tenancy.run(c.team.tenantId, work);
      c.inNone = (work) => tenancy.run(null, work);
      c.exported = async (userId, section) => {
        const batches: PersonalDataBatch[] = [];
        await c.app.get(PersonalDataService).export(userId, async (batch) => {
          batches.push(batch);
        });
        return batches
          .filter((batch) => batch.section === section)
          .flatMap((batch) => batch.rows);
      };
      await test.seed(c);
    });
    afterAll(() => c.app?.close());

    it("exports the person's rows only", () => test.exported(c));

    it('erases or anonymises the person, and no one else', async () => {
      const personal = c.app.get(PersonalDataService);
      const tx = c.app.get(TransactionHost);
      await c.inTenant(() =>
        tx.withTransaction(() => personal.erase(c.a.id, c.team.tenantId)),
      );
      await c.inNone(() =>
        tx.withTransaction(() => personal.erase(c.a.id, null)),
      );
      await test.erased(c);
    });
  });
}

/** A fresh id, for rows that point at a record no test needs. */
export const uuid = () => randomUUID();
