// The `bulk` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons bulk` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { CORE } from '../../../schematics/feature/kit.js';

export default {
  order: 130,
  about: 'delete, restore or change many at once',
  imports: { BulkModule: 'modules/bulk/bulk.module.js' },
  call: (c) => `BulkModule.forRecord(${c.R})`,
  boot: { QueuesModule: CORE.QueuesModule },
  env: { APP_ROLE: 'all' },
  test: (c) => `
it('bulk: deletes the records sent', async () => {
  const item = await create();
  const run = await call('POST', '${c.url}/bulk', ${c.writer}, { action: 'delete', ids: [item.id] });
  expect(run.statusCode, run.body).toBe(200);
  expect(run.json()).toMatchObject({ done: 1 });
});`,
  routes: ['bulk'],
};
