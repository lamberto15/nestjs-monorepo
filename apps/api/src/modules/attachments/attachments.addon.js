// The `attachments` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons attachments` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { CORE, WORKERS } from '../../../schematics/feature/kit.js';

export default {
  order: 30,
  about: 'files on a record, scanned and stored on the private disk',
  imports: { AttachmentsModule: 'modules/attachments/attachments.module.js' },
  call: (c) => `AttachmentsModule.forRecord(${c.R})`,
  boot: {
    QueuesModule: CORE.QueuesModule,
    MetricsModule: CORE.MetricsModule,
    StorageModule: 'modules/storage/storage.module.js',
  },
  env: { ...WORKERS, STORAGE_DRIVER: 'memory' },
  test: (c) => `
it('attachments: a record lists its files', async () => {
  const item = await create();
  const files = await call('GET', \`${c.url}/\${item.id}/attachments\`, ${c.writer});
  expect(files.statusCode, files.body).toBe(200);
  expect(files.json().items).toEqual([]);
});`,
  routes: ['attachments'],
};
