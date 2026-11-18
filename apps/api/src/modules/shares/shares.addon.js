// The `shares` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons shares` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { CORE, WORKERS } from '../../../schematics/feature/kit.js';

export default {
  order: 170,
  about: 'read-only links to one record',
  imports: { SharesModule: 'modules/shares/shares.module.js' },
  call: (c) => `SharesModule.forRecord(${c.R})`,
  boot: { QueuesModule: CORE.QueuesModule },
  env: { ...WORKERS, WEB_URL: 'https://web.example.com' },
  test: (c) => `
it('shares: a link to a record is made', async () => {
  const item = await create();
  const share = await call('POST', \`${c.url}/\${item.id}/shares\`, ${c.writer}, { fields: ['${c.fields[0].name}'], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  expect(share.statusCode, share.body).toBe(201);
});`,
  routes: ['shares'],
  actions: (c) => ({ share: 'Share ' + c.t.nouns + ' by a link' }),
};
