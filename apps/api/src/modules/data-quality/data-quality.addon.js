// The `data-quality` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons data-quality` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { CORE } from '../../../schematics/feature/kit.js';

export default {
  order: 160,
  about: 'scans for missing values, duplicates and broken rules',
  imports: { DataQualityModule: 'modules/data-quality/data-quality.module.js' },
  call: (c) => {
    const recommended = c.fields
      .filter((f) => f.optional && ['string', 'text'].includes(f.type))
      .map((f) => `'${f.name}'`);
    return recommended.length
      ? `DataQualityModule.forRecord(${c.R}, { recommended: [${recommended.join(', ')}] })`
      : `DataQualityModule.forRecord(${c.R})`;
  },
  comment:
    'Business logic: its checks (recommended, duplicates, rules: modules/data-quality/README.md).',
  boot: { QueuesModule: CORE.QueuesModule },
  env: { APP_ROLE: 'all' },
  test: (c) => `
it('data quality: a record has its findings', async () => {
  const item = await create();
  const findings = await call('GET', \`${c.url}/\${item.id}/data-quality\`, team.admin.headers);
  expect(findings.statusCode, findings.body).toBe(200);
});`,
  routes: ['data-quality'],
};
