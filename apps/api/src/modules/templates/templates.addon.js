// The `templates` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons templates` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.

export default {
  order: 70,
  about: 'saved values that prefill a create',
  imports: { TemplatesModule: 'modules/templates/templates.module.js' },
  call: (c) => `TemplatesModule.forRecord(${c.R})`,
  test: (c) => `
it('templates: the record takes templates', async () => {
  const subjects = await call('GET', '/v1/templates/subjects', ${c.writer});
  expect(subjects.statusCode, subjects.body).toBe(200);
  expect(subjects.body).toContain('${c.t.Singular}');
});`,
};
