// The `data-transfer` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons data-transfer` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { CORE, ENCRYPTION } from '../../../schematics/feature/kit.js';

export default {
  order: 150,
  about: 'exports to and imports from CSV or Excel',
  imports: {
    DataTransferModule: 'modules/data-transfer/data-transfer.module.js',
  },
  call: (c) => `DataTransferModule.forRecord(${c.R})`,
  boot: {
    QueuesModule: CORE.QueuesModule,
    StorageModule: 'modules/storage/storage.module.js',
  },
  env: { APP_ROLE: 'all', STORAGE_DRIVER: 'memory', ...ENCRYPTION },
  test: (c) => `
it('data transfer: gives the file to fill for an import', async () => {
  const template = await call('GET', '/v1/data/imports/${c.t.plural}/template', ${c.writer});
  expect(template.statusCode, template.body).toBe(200);
});`,
};
