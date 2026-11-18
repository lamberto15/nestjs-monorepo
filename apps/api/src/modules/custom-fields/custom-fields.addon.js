// The `custom-fields` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons custom-fields` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.

export default {
  order: 90,
  about: 'fields administrators add at runtime',
  imports: {
    CustomFieldsModule: 'modules/custom-fields/custom-fields.module.js',
    CUSTOM_FIELDS_BODY: 'modules/custom-fields/custom-fields.schemas.js',
    CUSTOM_FIELDS_RESPONSE: 'modules/custom-fields/custom-fields.schemas.js',
  },
  call: (c) => `CustomFieldsModule.forRecord(${c.R})`,
  body: ['CUSTOM_FIELDS_BODY'],
  response: ['CUSTOM_FIELDS_RESPONSE'],
  test: () => `
it('custom fields: a record shows its custom values', async () => {
  const item = await create();
  expect(item.custom).toEqual({});
});`,
};
