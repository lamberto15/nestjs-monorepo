// The `webhooks` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons webhooks` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { ENCRYPTION } from '../../../schematics/feature/kit.js';

export default {
  order: 220,
  about: "a record's changes as webhooks for API clients",
  imports: { WebhooksModule: 'modules/webhooks/webhooks.module.js' },
  call: (c) => `WebhooksModule.forRecord(${c.R})`,
  boot: { WebhooksModule: 'modules/webhooks/webhooks.module.js' },
  env: {
    WEBHOOKS_WORKER: 'off',
    WEBHOOKS_ALLOW_LOOPBACK: 'on',
    ...ENCRYPTION,
  },
  test: (c) => `
it('webhooks: its changes are event types', async () => {
  const types = await call('GET', '/v1/webhook-event-types', ${c.writer});
  expect(types.statusCode, types.body).toBe(200);
  expect(types.body).toContain('${c.t.singularCamel}.created');
});`,
};
