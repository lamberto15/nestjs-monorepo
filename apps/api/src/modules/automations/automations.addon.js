// The `automations` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons automations` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { CORE, WORKERS } from '../../../schematics/feature/kit.js';

export default {
  order: 200,
  about: "tenants' rules on a record's changes",
  imports: { AutomationsModule: 'modules/automations/automations.module.js' },
  call: (c) => `AutomationsModule.forRecord(${c.R})`,
  boot: {
    QueuesModule: CORE.QueuesModule,
    WebhooksModule: 'modules/webhooks/webhooks.module.js',
    AutomationsModule: 'modules/automations/automations.module.js',
  },
  env: { ...WORKERS, WEBHOOKS_WORKER: 'off', WEBHOOKS_ALLOW_LOOPBACK: 'on' },
  test: (c) => `
it('automations: the record takes rules', async () => {
  const list = await call('GET', '/v1/lists/${c.t.Singular}', ${c.writer});
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json().capabilities).toMatchObject({ automations: true });
});`,
};
