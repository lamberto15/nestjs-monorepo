// The `comments` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons comments` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { CORE, WORKERS } from '../../../schematics/feature/kit.js';

export default {
  order: 20,
  about: 'threads, mentions and replies on a record',
  imports: { CommentsModule: 'modules/comments/comments.module.js' },
  call: (c) => `CommentsModule.forRecord(${c.R})`,
  boot: { QueuesModule: CORE.QueuesModule },
  env: WORKERS,
  test: (c) => `
it('comments: one is added and listed', async () => {
  const item = await create();
  const added = await call('POST', \`${c.url}/\${item.id}/comments\`, ${c.writer}, { body: 'A first comment' });
  expect(added.statusCode, added.body).toBe(201);
  const listed = await call('GET', \`${c.url}/\${item.id}/comments\`, ${c.writer});
  expect(listed.json().items).toHaveLength(1);
});`,
  routes: ['comments'],
};
