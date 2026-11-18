// The `notifications` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons notifications` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { CORE, WORKERS } from '../../../schematics/feature/kit.js';

export default {
  order: 230,
  about: 'watching a record, and its watchers told of changes',
  imports: {
    NotificationsModule: 'modules/notifications/notifications.module.js',
  },
  call: (c) => `NotificationsModule.forRecord(${c.R})`,
  boot: {
    QueuesModule: CORE.QueuesModule,
    NotificationsModule: 'modules/notifications/notifications.module.js',
  },
  env: WORKERS,
  test: (c) => `
it('notifications: a record is watched', async () => {
  const item = await create();
  const watched = await call('POST', \`${c.url}/\${item.id}/watch\`, ${c.writer});
  expect(watched.statusCode, watched.body).toBeLessThan(300);
});`,
  routes: ['watch'],
};
