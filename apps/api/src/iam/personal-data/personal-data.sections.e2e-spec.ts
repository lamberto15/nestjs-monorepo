import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import {
  recordsTenant,
  testItemModules,
  unitWithLead,
} from '../../../test/records.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { PersonalDataModule } from './personal-data.module.js';
import {
  type PersonalDataBatch,
  PersonalDataService,
} from './personal-data.service.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-personal-sections-${process.pid}-${Date.now()}`,
  });
});

/**
 * The sections of this module's own (personal-data.sections.ts). A module's
 * section is tested beside it (`<name>.personal-data.e2e-spec.ts`, with
 * test/personal-data.ts).
 */
describe('personal data: the roles and units sections (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      PersonalDataModule,
    );
    team = await recordsTenant(app);
  });
  afterAll(() => app?.close());

  async function exported(userId: string, section: string) {
    const batches: PersonalDataBatch[] = [];
    await app.get(PersonalDataService).export(userId, async (batch) => {
      batches.push(batch);
    });
    return batches
      .filter((batch) => batch.section === section)
      .flatMap((batch) => batch.rows);
  }

  it('shows the roles and organizational units of the person', async () => {
    const { unitId, worker, lead } = await unitWithLead(app, team);
    expect((await exported(team.editor.id, 'roles')).map((r) => r.key)).toEqual(
      ['editor'],
    );
    expect(await exported(team.nobody.id, 'roles')).toEqual([]);
    expect(
      (await exported(worker.id, 'organizational-units')).map((r) => [
        r.id,
        r.role,
      ]),
    ).toEqual([[unitId, 'member']]);
    expect(
      (await exported(lead.id, 'organizational-units')).map((r) => r.role),
    ).toEqual(['lead']);
    expect(await exported(team.nobody.id, 'organizational-units')).toEqual([]);
  });
});
