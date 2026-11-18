// The `retention` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons retention` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { CORE } from '../../../schematics/feature/kit.js';

export default {
  order: 250,
  about: 'records purged after the days a tenant sets',
  imports: { RetentionModule: 'modules/retention/retention.module.js' },
  call: (c) =>
    `RetentionModule.forRecord(${c.R}, ${c.T}, { defaultDays: 730, minDays: 30 })`,
  comment:
    'Business logic: how long its records are kept by default (off until a tenant turns the rule on).',
  tableImport: true,
  boot: {
    QueuesModule: CORE.QueuesModule,
    HoldsModule: 'iam/holds/holds.module.js',
    RetentionModule: 'modules/retention/retention.module.js',
  },
  env: { APP_ROLE: 'all' },
  test: (c) => `
it('retention: the record has a rule', async () => {
  const rules = await call('GET', '/v1/retention/rules', team.admin.headers);
  expect(rules.statusCode, rules.body).toBe(200);
  expect(rules.body).toContain('"${c.t.plural}"');
});`,
};
