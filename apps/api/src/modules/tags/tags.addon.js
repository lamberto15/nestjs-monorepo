// The `tags` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons tags` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.

export default {
  order: 10,
  about: 'labels set per record, `?tag=` on the list',
  imports: {
    TagsModule: 'modules/tags/tags.module.js',
    TAGS_RESPONSE: 'modules/tags/tags.schemas.js',
  },
  call: (c) => `TagsModule.forRecord(${c.R})`,
  response: ['TAGS_RESPONSE'],
  test: (c) => `
it('tags: a tag set on one is shown with it', async () => {
  const item = await create();
  const tag = await call('POST', '/v1/tags', team.admin.headers, { subject: '${c.t.Singular}', name: 'Urgent' });
  expect(tag.statusCode, tag.body).toBe(201);
  const set = await call('PUT', \`${c.url}/\${item.id}/tags\`, ${c.writer}, { tagIds: [tag.json().id] });
  expect(set.statusCode, set.body).toBe(200);
  const read = await call('GET', \`${c.url}/\${item.id}\`, ${c.writer});
  expect(read.json().tags).toHaveLength(1);
});`,
  routes: ['tags'],
};
