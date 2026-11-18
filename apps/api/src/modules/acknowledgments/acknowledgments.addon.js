// The `acknowledgments` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons acknowledgments` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { CORE, WORKERS } from '../../../schematics/feature/kit.js';

export default {
  order: 120,
  about: '"I have read this", per version',
  imports: {
    AcknowledgmentsModule: 'modules/acknowledgments/acknowledgments.module.js',
  },
  call: (c) => `AcknowledgmentsModule.forRecord(${c.R})`,
  boot: { QueuesModule: CORE.QueuesModule },
  env: WORKERS,
  test: (c) => `
it('acknowledgments: a record has its dashboard', async () => {
  const item = await create();
  const dashboard = await call('GET', \`${c.url}/\${item.id}/acknowledgments\`, ${c.writer});
  expect(dashboard.statusCode, dashboard.body).toBe(200);
});`,
  routes: ['acknowledgments', 'acknowledge'],
};
